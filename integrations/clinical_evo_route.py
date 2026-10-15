from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from clinical_rag.api.dependencies.auth import get_current_principal
from clinical_rag.api.routes.conversations import get_conversation_service
from clinical_rag.evo_bridge import BridgeRequest, envelope, prepare, submit

router = APIRouter(prefix="/evo", tags=["evaluation"])


def snapshot(thread_id, principal, service):
    store = service._store
    conversations = service.list_conversations(user_id=principal.user_id, include_archived=True)["items"]
    conversation = next((item for item in conversations if item["thread_id"] == thread_id), None)
    if not conversation:
        raise HTTPException(404, "conversation_not_found")
    messages = service.get_messages(thread_id)["items"]
    # Ownership is checked before reading any messages or execution evidence.
    if any(item.get("user_id") != principal.user_id for item in messages):
        raise HTTPException(403, "会话包含其他用户的消息，不能导出")
    runs = [item for item in store.list_agent_runs() if item["thread_id"] == thread_id and item.get("user_id") == principal.user_id]
    if any(item["status"] == "running" for item in runs):
        raise HTTPException(409, "会话仍在执行，请等当前回答结束后评测")
    by_request = {item["request_message_id"]: item for item in runs if item.get("request_message_id")}
    by_id = {item["message_id"]: item for item in messages}
    turns = []
    for message in messages:
        if message["role"] != "user":
            continue
        run = by_request.get(message["message_id"], {})
        assistant = by_id.get(run.get("response_message_id"), {})
        steps = store.list_agent_steps(run_id=run["run_id"]) if run else []
        answer, coverage = assistant.get("content", ""), "saved_summary" if assistant else "missing"
        # Clinical nodes persist the full answer object in the actual payload.
        for step in steps:
            candidate = (step.get("payload") or {}).get("answer")
            if isinstance(candidate, dict) and candidate.get("summary"):
                answer, coverage = candidate, "full"
        trace = run.get("final_trace") or assistant.get("trace") or {}
        saved = (assistant.get("trace") or {}).get("answer_snapshot")
        if isinstance(saved, dict) and saved.get("summary"):
            answer, coverage = saved, "full"
        usage = trace.get("model_usage") or {}
        usage_events = usage.get("events") or []
        successful = [item for item in usage_events if item.get("status") == "success" and item.get("usage_status") == "provider_reported" and item.get("model_name") and item.get("run_id") == run.get("run_id")]
        evidence = {**usage, "calls": len(successful), "verified": bool(successful), "source": "native_run_final_trace"}
        okay = run.get("status") == "completed" and bool(assistant)
        turns.append({"turn_index": len(turns) + 1, "message": message["content"], "request_message_id": message["message_id"],
                      "response_message_id": assistant.get("message_id"), "conversation_id": thread_id,
                      "status": "completed" if okay else "blocked", "session_verified": bool(run and assistant),
                      "business_run_id": run.get("run_id"), "business_execution_id": None,
                      "model_calls": evidence["calls"], "model_evidence": evidence,
                      "output": {"business_status": "succeeded" if okay else "failed", "result": {"answer": answer, "trace": trace}},
                      "events": [{"kind": "business_step", "node": step["node_name"], "status": step["status"],
                                  "payload": {"summary": step.get("output_summary"), **(step.get("payload") or {}), "source_sequence": step["sequence"]}} for step in steps],
                      "version": run.get("version_snapshot") or {}, "answer_coverage": coverage,
                      "error_code": None if okay else "native_message_binding_missing", "started_at": str(message.get("created_at") or ""),
                      "finished_at": str(run.get("completed_at") or "")})
    attached = any((item.get("trace") or {}).get("attachment_ids") for item in messages)
    return envelope("clinical", principal.user_id, thread_id, str(conversation.get("title") or "临床会话"), turns, attached)


@router.post("/conversations/{thread_id}/preview")
def preview(thread_id: str, request: BridgeRequest, principal=Depends(get_current_principal), service=Depends(get_conversation_service)):
    return prepare(snapshot(thread_id, principal, service), request)


@router.post("/conversations/{thread_id}/evaluate")
def evaluate(thread_id: str, request: BridgeRequest, principal=Depends(get_current_principal), service=Depends(get_conversation_service)):
    return submit(prepare(snapshot(thread_id, principal, service), request))
