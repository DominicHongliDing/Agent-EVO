from __future__ import annotations

import sqlite3
from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import get_current_principal
from app.domains.turns.execution import TurnExecutionRepository
from app.runtime.container import get_repository, get_settings
from app.evo_bridge import BridgeRequest, envelope, prepare, submit

router = APIRouter(prefix="/evo", tags=["evaluation"])


def snapshot(conversation_id, principal):
    repository = get_repository()
    try:
        conversation = repository.get_conversation(conversation_id, principal)
    except KeyError:
        raise HTTPException(404, "conversation_not_found") from None
    messages = repository.list_messages(conversation_id, principal=principal)
    executions = TurnExecutionRepository(get_settings().database_path)
    records = executions.list_for_conversation(conversation_id, tenant_id=principal.tenant_id, owner_user_id=principal.user_id)
    if any(str(item.status) in {"running", "queued"} for item in records):
        raise HTTPException(409, "会话仍在执行，请等当前回答结束后评测")
    by_request = {item.result.user_message.id: item for item in records if item.result}
    turns = []
    attached = bool(repository.list_attachments(conversation_id, principal))
    for message in messages:
        if message.role != "user":
            continue
        execution = by_request.get(message.id)
        result = execution.result.model_dump(mode="json") if execution and execution.result else {}
        # Export actual workbench result, never arbitrary neighboring messages.
        for key in ("attachments", "artifacts", "workflow_case"):
            result.pop(key, None)
        if "conversation" in result:
            result["conversation"] = {"id": conversation_id}
        events = [{"kind": "business_event", "node": item.event, "status": item.status,
                   "payload": {"summary": item.summary, "details": item.details, "source_sequence": item.sequence}}
                  for item in executions.list_events(execution.id, principal)] if execution else []
        usage = []
        if execution:
            with sqlite3.connect(get_settings().database_path) as db:
                db.row_factory = sqlite3.Row
                usage = [dict(row) for row in db.execute("SELECT id,provider,model,purpose,input_units,output_units,latency_ms,status,created_at,execution_id FROM model_usage_events WHERE tenant_id=? AND user_id=? AND execution_id=? ORDER BY created_at", (principal.tenant_id, principal.user_id, execution.id))]
        successful = [item for item in usage if item["status"] == "succeeded" and item["provider"] in {"bailian", "dashscope", "openai_compatible"}]
        evidence = {"calls": len(successful), "verified": bool(successful), "events": usage, "source": "native_owner_scoped_usage_ledger"}
        assistant = result.get("assistant_message") or {}
        okay = bool(execution and str(execution.status) == "succeeded" and assistant.get("id"))
        turns.append({"turn_index": len(turns) + 1, "message": message.content, "request_message_id": message.id,
                      "response_message_id": assistant.get("id"), "conversation_id": conversation_id,
                      "status": "completed" if okay else "blocked", "session_verified": bool(execution and execution.run_id),
                      "business_run_id": execution.run_id if execution else None, "business_execution_id": execution.id if execution else None,
                      "model_calls": evidence["calls"], "model_evidence": evidence,
                      "output": {"business_status": "succeeded" if okay else "failed", "result": result}, "events": events,
                      "version": {}, "answer_coverage": "full" if assistant else "missing",
                      "error_code": None if okay else "native_message_binding_missing", "started_at": message.created_at,
                      "finished_at": execution.updated_at if execution else None})
    return envelope("unihr", principal.tenant_id + ":" + principal.user_id, conversation_id, conversation.title, turns, attached)


@router.post("/conversations/{conversation_id}/preview")
def preview(conversation_id: str, request: BridgeRequest, principal=Depends(get_current_principal)):
    return prepare(snapshot(conversation_id, principal), request)


@router.post("/conversations/{conversation_id}/evaluate")
def evaluate(conversation_id: str, request: BridgeRequest, principal=Depends(get_current_principal)):
    return submit(prepare(snapshot(conversation_id, principal), request))
