from __future__ import annotations

import json
import time

from agent_evo.adapters import AgentRunError, _unihr_usage, run_clinical, run_unihr
from agent_evo.generic_adapter import run_generic
from agent_evo.store import dumps, now


def answer_text(output: dict) -> str:
    result = output.get("result") or {}
    if not isinstance(result, dict):
        return ""
    message = result.get("assistant_message") or {}
    if isinstance(message, dict) and isinstance(message.get("content"), str):
        return message["content"]
    answer = result.get("answer")
    if isinstance(answer, str):
        return answer
    if isinstance(answer, dict):
        parts = [answer.get("summary", "")]
        # Clinical returns the same model text in summary and a display section.
        # Match its frontend: omit only that duplicate field, never repetition
        # within the actual model response.
        normalize = lambda value: ' '.join(str(value).split())
        for section in answer.get("sections", []):
            if not isinstance(section, dict):
                continue
            content = section.get('content', '')
            if (str(section.get('title', '')).strip().lower() in {'模型输出', 'model output'}
                    and normalize(content) == normalize(answer.get('summary', ''))):
                continue
            parts.append(content)
        return "\n".join(part for part in parts if isinstance(part, str) and part)
    return ""


def aggregate_evidence(rows: list[dict]) -> dict:
    return {"verified": bool(rows) and all(row["status"] == "completed" and row.get("session_verified")
                                          and row.get("model_evidence", {}).get("verified") and row.get("model_calls", 0) > 0 for row in rows),
            "calls": sum(row.get("model_calls", 0) for row in rows),
            "turn_count": len(rows), "verified_turns": sum(bool(row.get("model_evidence", {}).get("verified")) and row.get("model_calls", 0) > 0 for row in rows),
            "turns": [{"turn_index": row["turn_index"], "business_run_id": row.get("business_run_id"),
                       "business_execution_id": row.get("business_execution_id"), "model_evidence": row.get("model_evidence", {})} for row in rows]}


class TurnStore:
    """Tag actual business events and isolate each turn's counters before aggregation."""
    def __init__(self, store, row, rows):
        self.store, self.row, self.rows = store, row, rows
        self.local = {"model_calls": 0, "model_evidence": {}, "business_run_id": None, "business_execution_id": None}

    def __getattr__(self, key):
        return getattr(self.store, key)

    def get_run(self, run_id):
        return {**self.store.get_run(run_id), **self.local}

    def add_event(self, run_id, kind, node, status, payload, parent_span_id=None):
        value = {**payload, "turn_index": self.row["turn_index"]} if isinstance(payload, dict) else {"value": payload, "turn_index": self.row["turn_index"]}
        return self.store.add_event(run_id, kind, node, status, value, parent_span_id)

    def set_run_fields(self, run_id, **fields):
        for key in ("model_calls", "business_run_id", "business_execution_id"):
            if key in fields:
                self.local[key] = self.row[key] = fields[key]
        if "model_evidence_json" in fields:
            self.local["model_evidence"] = self.row["model_evidence"] = json.loads(fields["model_evidence_json"])
        if "model_calls" in fields or "model_evidence_json" in fields:
            evidence = aggregate_evidence(self.rows)
            fields.update(model_calls=evidence["calls"], model_evidence_json=dumps(evidence))
        self.store.set_run_fields(run_id, **fields)


def run_conversation(run: dict, case: dict, settings, store) -> dict:
    kind = run["agent_snapshot"]["adapter_kind"]
    rows = [{"turn_index": index, "message": turn["message"], "status": "not_started", "checks": turn.get("checks", [])}
            for index, turn in enumerate(case["turns"], 1)]
    session, history, business_ids = {}, [], set()
    conversation_id = f"evo_{run['run_id']}" if kind != "unihr" else None
    last_output = {}

    def publish():
        evidence = aggregate_evidence(rows)
        state = "succeeded" if all(row["status"] == "completed" for row in rows) else "failed" if any(row["status"] == "failed" for row in rows) else "running"
        result = {"business_status": state,
                  "result": last_output.get("result", {}), "conversation_id": conversation_id,
                  "conversation_turns": rows, "model_evidence": evidence}
        failed = next((row for row in rows if row["status"] == "failed"), None)
        if failed:
            result["error_code"] = failed.get("error_code", "conversation_turn_failed")
        store.set_run_fields(run["run_id"], output_json=dumps(result), model_calls=evidence["calls"], model_evidence_json=dumps(evidence))
        return result

    for row in rows:
        started = time.monotonic()
        row.update(status="running", started_at=now())
        scope = TurnStore(store, row, rows)
        scope.add_event(run["run_id"], "conversation", "conversation.turn.start", "running", {"message": row["message"], "conversation_id": conversation_id})
        publish()
        turn_case = {**case, "message": row["message"], "turns": [], "fixtures": case.get("fixtures", []) if row["turn_index"] == 1 else [],
                     "_conversation_id": conversation_id, "_turn_index": row["turn_index"], "_history": history}
        try:
            current = scope.get_run(run["run_id"])
            if kind == "clinical":
                output = run_clinical(current, turn_case, settings, scope, session=session)
            else:
                output = (run_unihr if kind == "unihr" else run_generic)(current, turn_case, settings, scope)
            last_output = output
            row["output"] = output
            received_id = output.get("conversation_id")
            row["conversation_id"] = received_id
            if not received_id or (conversation_id and received_id != conversation_id):
                raise AgentRunError("conversation_session_mismatch", "业务未返回一致的会话 ID，已停止后续轮次")
            conversation_id = received_id
            row["session_verified"] = True
            business_id = row.get("business_run_id") or row.get("business_execution_id")
            if not business_id or business_id in business_ids:
                raise AgentRunError("conversation_business_id_invalid", "本轮业务 ID 缺失或复用了前轮 ID，不能关联独立执行证据")
            business_ids.add(business_id)
            if output.get("business_status") != "succeeded":
                raise AgentRunError(str(output.get("error_code") or "conversation_turn_failed"), "本轮业务未成功完成")
            row["status"] = "completed"
            history.extend([{"role": "user", "content": row["message"]}, {"role": "assistant", "content": answer_text(output)}])
        except Exception as exc:
            # The failed turn can still have genuine model usage in the business ledger.
            if kind == "unihr" and row.get("business_execution_id"):
                usage = _unihr_usage(settings.unihr_usage_db, row["business_execution_id"])
                row.update(model_calls=int(usage.get("calls", 0)), model_evidence=usage)
            row.update(status="failed", error_code=getattr(exc, "code", type(exc).__name__), error=str(exc))
        row.update(finished_at=now(), latency_ms=round((time.monotonic() - started) * 1000))
        scope.add_event(run["run_id"], "conversation", "conversation.turn.finish", row["status"], {**row, "checks": []})
        publish()
        if row["status"] == "failed":
            break
    return publish()
