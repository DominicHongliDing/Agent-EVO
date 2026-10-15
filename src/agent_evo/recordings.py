"""Immutable native conversation snapshots; importing never invokes a business agent."""
from __future__ import annotations

import hashlib
import re
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, Field, ConfigDict, model_validator

from agent_evo.conversation import aggregate_evidence
from agent_evo.store import dumps, now


PRIVATE_KEY = re.compile(r"password|secret|authorization|api.?key|access.?token|cookie|saved_path|local_path|extracted_text|owner_user|tenant_id|patient_name|candidate_name", re.I)
PRIVATE_TEXT = re.compile(r"\b1[3-9]\d{9}\b|\b\d{17}[\dXx]\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+)\b")


def sanitize(value):
    if isinstance(value, dict):
        return {key: sanitize(item) for key, item in value.items() if not PRIVATE_KEY.search(key)}
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str):
        return PRIVATE_TEXT.sub("[已脱敏]", value)
    return value


class RecordedTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    turn_index: int = Field(ge=1, le=200)
    message: str = Field(min_length=1, max_length=20000)
    request_message_id: str = Field(min_length=1, max_length=200)
    response_message_id: str | None = Field(default=None, max_length=200)
    conversation_id: str = Field(min_length=1, max_length=200)
    status: Literal["completed", "failed", "blocked"]
    session_verified: bool = False
    business_run_id: str | None = None
    business_execution_id: str | None = None
    model_calls: int = Field(default=0, ge=0)
    model_evidence: dict = Field(default_factory=dict)
    output: dict = Field(default_factory=dict)
    events: list[dict] = Field(default_factory=list, max_length=2000)
    version: dict = Field(default_factory=dict)
    error_code: str | None = None
    answer_coverage: Literal["full", "saved_summary", "missing"] = "full"
    started_at: str | None = None
    finished_at: str | None = None


class RecordingInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    protocol: Literal["agent-evo-recording-v1"]
    agent_id: str = Field(min_length=1, max_length=100)
    source_scope: str = Field(pattern=r"^[a-f0-9]{64}$")
    conversation_id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=120)
    data_classification: Literal["synthetic", "deidentified"]
    privacy_confirmed: Literal[True]
    requires_attachments: bool = False
    turns: list[RecordedTurn] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def consistent(self):
        seen = set()
        for index, turn in enumerate(self.turns, 1):
            if turn.turn_index != index or turn.conversation_id != self.conversation_id:
                raise ValueError("轮次必须连续且属于同一来源会话")
            ids = (turn.request_message_id, turn.response_message_id)
            if any(item and item in seen for item in ids):
                raise ValueError("消息 ID 重复，不能证明每轮独立关联")
            seen.update(item for item in ids if item)
            if turn.model_calls != int(turn.model_evidence.get("calls", 0)):
                raise ValueError("模型调用数与本轮用量证据不一致")
            if turn.session_verified and (not turn.business_run_id and not turn.business_execution_id):
                raise ValueError("缺少独立业务 ID，不能标记会话关联已验证")
        if len(dumps(self.model_dump()).encode()) > 5_242_880:
            raise ValueError("快照超过 5 MiB，请选择更早的结束轮次")
        return self


def import_recording(store, payload: RecordingInput) -> dict:
    content = sanitize(payload.model_dump(mode="json"))
    digest = hashlib.sha256(dumps(content).encode()).hexdigest()
    agent = store.get_agent(payload.agent_id)
    if agent["deleted_at"] or agent["adapter_kind"] not in {"unihr", "clinical"}:
        raise ValueError("来源 Agent 必须为已接入的原生 Agent")
    key = hashlib.sha256((payload.agent_id + payload.source_scope + payload.conversation_id + digest).encode()).hexdigest()
    dataset_id = "dataset_recorded_" + payload.agent_id
    case_id = "recorded_" + key[:32]
    run_id, batch_id = "run_" + uuid4().hex, "batch_" + uuid4().hex
    rows = [{**turn, "checks": []} for turn in content["turns"]]
    evidence = aggregate_evidence(rows)
    output = {"business_status": "succeeded" if all(row["status"] == "completed" for row in rows) else "failed",
              "result": rows[-1]["output"].get("result", {}), "conversation_id": payload.conversation_id,
              "conversation_turns": rows, "recording": {"sha256": digest, "data_classification": payload.data_classification,
              "source_scope": payload.source_scope, "requires_attachments": payload.requires_attachments},
              "new_business_calls": 0}
    case = {"case_id": case_id, "agent": agent["adapter_kind"], "suite_version": "recorded-v1", "category": "recorded_conversation",
            "title": content["title"], "message": rows[0]["message"], "synthetic": payload.data_classification == "synthetic",
            "risk_level": "critical" if agent["adapter_kind"] == "clinical" else "standard", "fixtures": [], "expected": {},
            "model_required": True, "gold_status": "engineering_draft", "turns": [{"message": row["message"], "checks": []} for row in rows],
            "recording_origin": output["recording"]}
    case_sha = hashlib.sha256(dumps(case).encode()).hexdigest()
    snapshot = {**agent, "dataset_name": "原生对话记录"}
    with store.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        prior = db.execute("SELECT run_id FROM recordings WHERE recording_key=?", (key,)).fetchone()
        if prior:
            return {"run_id": prior["run_id"], "deduplicated": True}
        db.execute("INSERT OR IGNORE INTO datasets VALUES(?,?,?,?,?,?,?,?,NULL)",
                   (dataset_id, agent["name"] + " · 原生对话记录", "合成或脱敏的原生问答快照", agent["adapter_kind"], "v1", "native-recordings", digest, now()))
        db.execute("INSERT OR IGNORE INTO agent_datasets VALUES(?,?)", (agent["agent_id"], dataset_id))
        db.execute("INSERT INTO cases(case_id,agent,category,suite_version,risk_level,content_sha256,data_json,dataset_id) VALUES(?,?,?,?,?,?,?,?)",
                   (case_id, case["agent"], case["category"], case["suite_version"], case["risk_level"], case_sha, dumps(case), dataset_id))
        db.execute("INSERT INTO batches(batch_id,label,created_at) VALUES(?,?,?)", (batch_id, "已有对话评测 · " + content["title"][:90], now()))
        db.execute("INSERT INTO runs(run_id,batch_id,case_id,trace_id,status,case_sha256,agent_id,dataset_id,agent_snapshot_json,execution_mode,model_calls,model_evidence_json,output_json,version_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (run_id, batch_id, case_id, uuid4().hex, "queued", case_sha, agent["agent_id"], dataset_id, dumps(snapshot), "recorded", evidence["calls"], dumps(evidence), dumps(output), dumps({"recording_sha256": digest, "source_versions": [row["version"] for row in rows]})))
        db.execute("INSERT INTO recordings VALUES(?,?,?,?)", (key, digest, run_id, now()))
        for row in rows:
            for event in row["events"]:
                db.execute("INSERT INTO events(run_id,span_id,kind,node,status,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
                           (run_id, uuid4().hex[:16], event.get("kind", "business_step"), str(event.get("node", "unknown")), str(event.get("status", "observed")), dumps({**(event.get("payload") or {}), "turn_index": row["turn_index"], "source_event": event}), now()))
        db.execute("INSERT INTO events(run_id,span_id,kind,node,status,payload_json,created_at) VALUES(?,?,?,?,?,?,?)",
                   (run_id, uuid4().hex[:16], "recording", "recording.import", "completed", dumps(output["recording"]), now()))
    return {"run_id": run_id, "batch_id": batch_id, "deduplicated": False}


def assert_replayable(case: dict) -> None:
    origin = case.get("recording_origin") or {}
    if origin.get("requires_attachments"):
        raise ValueError("原会话依赖附件，快照不复制附件。请先建立含脱敏附件的测试集再重跑。")
    if origin and len(case.get("turns") or []) > 12:
        raise ValueError("真实重跑最多 12 轮，请在原生页面选择更早结束轮次后提交。")
