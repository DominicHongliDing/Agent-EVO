from __future__ import annotations

import hashlib
import os
import re
from dataclasses import replace
from pathlib import Path

from agent_evo.adapters import AgentRunError, _client
from agent_evo.config import Settings
from agent_evo.store import Store, dumps


def _redact(value, token: str = ""):
    if isinstance(value, dict):
        return {key: "[redacted]" if re.fullmatch(r"password|access_token|api[_-]?key|secret|credentials?|authorization", str(key), re.I)
                else _redact(item, token) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact(item, token) for item in value]
    if isinstance(value, str):
        return value.replace(token, "[redacted]") if token else value
    return value


def target_settings(settings: Settings, target: dict) -> Settings:
    kind, prefix = target["adapter_kind"], target.get("credential_env_prefix", "")
    if kind == "unihr":
        changes = {"unihr_url": target["base_url"]}
        if prefix != "EVO_UNIHR":
            usage = os.getenv(prefix + "_USAGE_DB_PATH", "") if prefix else ""
            changes.update(unihr_username=os.getenv(prefix + "_USERNAME", "") if prefix else "",
                           unihr_password=os.getenv(prefix + "_PASSWORD", "") if prefix else "",
                           unihr_usage_db=Path(usage).resolve() if usage else None)
        return replace(settings, **changes)
    if kind == "clinical":
        return replace(settings, clinical_url=target["base_url"], clinical_access_token=settings.clinical_access_token if prefix == "EVO_CLINICAL" else os.getenv(prefix + "_ACCESS_TOKEN", "") if prefix else "")
    return settings


def run_generic(run: dict, case: dict, settings: Settings, store: Store) -> dict:
    target = run["agent_snapshot"]
    prefix = target.get("credential_env_prefix", "")
    token = os.getenv(prefix + "_ACCESS_TOKEN", "") if prefix else ""
    payload = {"protocol": "agent-evo-http-v1", "run_id": run["run_id"], "trace_id": run["trace_id"],
               "case_id": case.get("source_case_id", case["case_id"]), "message": case["message"], "case_context_text": case.get("case_context_text")}
    if case.get("_conversation_id"):
        payload.update(conversation_id=case["_conversation_id"], turn_index=case["_turn_index"], history=case["_history"])
    store.add_event(run["run_id"], "platform", "agent.http.request", "running", {"agent_id": target["agent_id"], "endpoint_path": target["endpoint_path"]})
    with _client(target["base_url"], settings.timeout_seconds) as client:
        response = client.post(target["endpoint_path"], json=payload, headers={"Authorization": f"Bearer {token}"} if token else {})
        if len(response.content) > 5_242_880:
            store.add_event(run["run_id"], "platform", "agent.http.response", "failed", {"http_status": response.status_code, "byte_size": len(response.content), "response_sha256": hashlib.sha256(response.content).hexdigest()})
            raise AgentRunError("agent_response_too_large", "Agent 响应超过 5 MiB")
        try:
            output = _redact(response.json(), token)
        except ValueError:
            store.add_event(run["run_id"], "platform", "agent.http.response", "failed", {"http_status": response.status_code, "raw_text": _redact(response.text, token), "response_sha256": hashlib.sha256(response.content).hexdigest()})
            raise AgentRunError("agent_response_not_json", "Agent 响应不是有效 JSON，响应证据已保存")
        store.add_event(run["run_id"], "platform", "agent.http.response", "observed" if response.is_success else "failed", {"http_status": response.status_code, "response": output, "response_sha256": hashlib.sha256(response.content).hexdigest()})
        response.raise_for_status()
    if not isinstance(output, dict) or output.get("business_status") not in {"succeeded", "failed"} or not isinstance(output.get("result"), dict):
        raise AgentRunError("agent_protocol_invalid", "Agent 响应须含 business_status 与 result 对象")
    business_id = output.get("business_run_id")
    if not isinstance(business_id, str) or not business_id:
        raise AgentRunError("agent_run_id_missing", "业务 run ID 缺失，不能建立运行关联")
    store.set_run_fields(run["run_id"], business_run_id=business_id)
    events = output.get("events", [])
    if not isinstance(events, list) or len(events) > 2000:
        raise AgentRunError("agent_events_invalid", "节点事件须为最多 2,000 项的数组")
    for event in events:
        if not isinstance(event, dict) or not isinstance(event.get("node"), str) or not isinstance(event.get("status"), str):
            raise AgentRunError("agent_events_invalid", "节点事件缺少 node/status")
        store.add_event(run["run_id"], "business_trace", event["node"], event["status"], {**event, "event": event["node"]})
    raw_usage = output.get("model_usage", {})
    usage_events = raw_usage.get("events", []) if isinstance(raw_usage, dict) else []
    valid = []
    if isinstance(usage_events, list):
        for item in usage_events:
            if not isinstance(item, dict):
                continue
            units = (item.get("prompt_tokens"), item.get("completion_tokens"))
            if (item.get("run_id") == business_id and item.get("status") == "success" and item.get("usage_status") == "provider_reported"
                    and isinstance(item.get("model_name"), str) and item["model_name"] and isinstance(item.get("provider"), str) and item["provider"]
                    and all(isinstance(unit, int) and not isinstance(unit, bool) and unit >= 0 for unit in units)):
                valid.append(item)
    evidence = {"verified": bool(valid), "calls": len(valid), "bailian_calls": sum(event["provider"] in {"bailian", "dashscope", "aliyun"} for event in valid),
                "events": usage_events, "business_run_id": business_id, "evidence_origin": "agent_reported_provider_usage", "independent_provider_audit": False}
    store.set_run_fields(run["run_id"], model_calls=len(valid), model_evidence_json=dumps(evidence),
                         version_json=dumps({**(run.get("version") or {}), "agent_config_sha256": hashlib.sha256(dumps(target).encode()).hexdigest(),
                                             "business_version_snapshot": output.get("version", {}), "response_sha256": hashlib.sha256(response.content).hexdigest()}))
    output["model_evidence"] = evidence
    return output
