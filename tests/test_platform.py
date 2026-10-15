from __future__ import annotations

import json
import sqlite3
from dataclasses import replace
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from agent_evo import adapters
from agent_evo.api import create_app
from agent_evo.config import Settings
from agent_evo.evaluation import evaluate_run
from agent_evo.store import Store, dumps, now


def settings(tmp_path: Path) -> Settings:
    base = Settings.from_env()
    return replace(base, db_path=tmp_path / "evo.db", artifact_root=tmp_path / "artifacts",
                   unihr_username="", unihr_password="", unihr_usage_db=None)


def test_frozen_100_cases_and_persistent_batch(tmp_path: Path) -> None:
    store = Store(settings(tmp_path))
    cases = store.list_cases()
    assert len(cases) == 100
    assert sum(c["agent"] == "unihr" for c in cases) == 50
    assert sum(c["agent"] == "clinical" for c in cases) == 50
    assert all(c["synthetic"] and c["gold_status"] == "engineering_draft" for c in cases)
    batch = store.create_batch([cases[0]["case_id"], cases[50]["case_id"]], "test")
    assert batch["total"] == 2
    assert Store(settings(tmp_path)).get_batch(batch["batch_id"])["total"] == 2
    claimed = store.claim_next("worker-test")
    assert claimed and claimed["status"] == "running"
    assert store.events(claimed["run_id"])[0]["node"] == "runner.claim"
    assert store.mark_interrupted() == [claimed["run_id"]]
    assert store.get_run(claimed["run_id"])["error_code"] == "interrupted_unknown"


def test_diagnosis_distinguishes_intent_retrieval_and_source_selection(tmp_path: Path) -> None:
    store = Store(settings(tmp_path))
    case = next(c for c in store.list_cases("clinical") if c["case_id"] == "clinical_medication_01_v1")
    batch = store.create_batch([case["case_id"]], "diagnostic")
    run = store.claim_next("worker-test")
    assert run and run["batch_id"] == batch["batch_id"]
    output = {"business_status": "succeeded", "result": {"trace": {
        "intent": "general_qa", "needs_retrieval": True, "retrieval_candidate_count": 0,
        "selected_sources": [], "evidence_sufficient": False, "safety_review_status": "ok",
    }}}
    store.set_run_fields(run["run_id"], status="completed", output_json=dumps(output),
                         model_calls=1, model_evidence_json=dumps({"verified": True, "calls": 1}),
                         version_json=dumps({"local_corpus_sha256": case["expected"]["corpus_sha256"]}),
                         finished_at=now())
    store.add_event(run["run_id"], "business_step", "retrieve_evidence", "failed", {"error": "index unavailable"})
    diagnosis = evaluate_run(store, run["run_id"])
    dimensions = {f["dimension"]: f["status"] for f in diagnosis["findings"]}
    assert dimensions["intent"] == "fail"
    assert dimensions["retrieval"] == "fail"
    assert dimensions["source_selection"] == "fail"
    assert dimensions["critical_safety"] == "unjudged"
    assert diagnosis["first_failure"]["dimension"] == "business_node"
    assert diagnosis["first_failure"]["evidence"][0].startswith("event:")
    assert diagnosis["clinical_validation"] == "not_performed"
    assert len(store.verdicts(run["run_id"])) == len(diagnosis["findings"])


def test_api_run_detail_and_retry_keeps_prior_record(tmp_path: Path) -> None:
    app = create_app(settings(tmp_path), start_worker=False)
    with TestClient(app) as client:
        items = client.get("/api/cases").json()["items"]
        created = client.post("/api/batches", json={"case_ids": [items[0]["case_id"]], "label": "api-test"})
        assert created.status_code == 201
        run_id = created.json()["runs"][0]["run_id"]
        detail = client.get(f"/api/runs/{run_id}")
        assert detail.status_code == 200
        assert detail.json()["case"]["case_id"] == items[0]["case_id"]
        assert client.post(f"/api/runs/{run_id}/cancel").status_code == 200
        retry = client.post(f"/api/runs/{run_id}/retry")
        assert retry.status_code == 201
        assert retry.json()["retry_of"] == run_id
        assert client.get(f"/api/runs/{run_id}").json()["status"] == "cancelled"


def test_unihr_adapter_uses_full_business_entry_and_usage_ledger(tmp_path: Path, monkeypatch) -> None:
    config = settings(tmp_path)
    usage_db = tmp_path / "usage.db"
    with sqlite3.connect(usage_db) as db:
        db.execute("CREATE TABLE model_usage_events (run_id TEXT,provider TEXT,model TEXT,purpose TEXT,"
                   "operation_kind TEXT,status TEXT,input_units INTEGER,output_units INTEGER,"
                   "latency_ms INTEGER,estimated_cost_cny REAL,pricing_configured INTEGER,created_at TEXT)")
        db.execute("INSERT INTO model_usage_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                   ("execution-1", "bailian", "qwen-test", "answer", "chat", "succeeded",
                    10, 5, 100, 0.001, 1, now()))
    config = replace(config, unihr_username="synthetic-user", unihr_password="test-only",
                     unihr_usage_db=usage_db)
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(f"{request.method} {request.url.path}")
        if request.url.path.endswith("/auth/login"):
            return httpx.Response(200, json={"access_token": "synthetic-token"})
        if request.url.path.endswith("/turns:start"):
            assert b"message" in request.content
            return httpx.Response(202, json={"id": "execution-1"})
        if request.url.path.endswith("/events"):
            return httpx.Response(200, text='data: {"sequence":1,"event":"route","status":"completed"}\n\n')
        if request.url.path.endswith("/turns/execution-1"):
            return httpx.Response(200, json={"status": "succeeded", "run_id": "business-1",
                                             "result": {"interpretation": {"business_intent": "policy_question",
                                                                            "retrieval_mode": "internal"},
                                                        "trace": [], "artifacts": []}})
        if request.url.path.endswith("/runs/business-1"):
            return httpx.Response(200, json={"events": []})
        return httpx.Response(404)

    monkeypatch.setattr(adapters, "_client", lambda base_url, timeout: httpx.Client(
        base_url=base_url, transport=httpx.MockTransport(handler)))
    store = Store(config)
    case = next(c for c in store.list_cases("unihr") if c["category"] == "policy")
    store.create_batch([case["case_id"]], "adapter-contract")
    run = store.claim_next("worker-test")
    assert run
    output = adapters.run_unihr(run, case, config, store)
    assert "POST /api/v1/assistant/turns:start" in requested
    assert "POST /api/v1/assistant/turn" not in requested
    assert output["model_evidence"]["bailian_calls"] == 1
    assert store.get_run(run["run_id"])["business_execution_id"] == "execution-1"
    assert any(e["kind"] == "business_event" for e in store.events(run["run_id"]))


def test_clinical_adapter_records_stream_steps_and_model_usage(tmp_path: Path, monkeypatch) -> None:
    config = settings(tmp_path)
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(f"{request.method} {request.url.path}")
        if request.url.path == "/auth/register":
            return httpx.Response(200, json={"user": {"user_id": "synthetic-clinician"}})
        if request.url.path == "/auth/login":
            return httpx.Response(200, json={"access_token": "synthetic-token"})
        if request.url.path == "/auth/me":
            return httpx.Response(200, json={"user": {"user_id": "synthetic-clinician"}})
        if request.url.path == "/chat/stream":
            body = json.loads(request.content)
            assert body["thread_id"].startswith("evo_run_")
            assert body["user_id"] == "synthetic-clinician"
            final = {"type": "final", "response": {"run_id": "business-clinical-1", "answer": "合成答案",
                     "trace": {"intent": "medication_safety", "needs_retrieval": True,
                               "retrieval_candidate_count": 2,
                               "model_usage": {"successful_request_count": 1,
                                               "events": [{"model_name": "qwen-test", "status": "success"}]}}}}
            return httpx.Response(200, text=f"event: final\ndata: {json.dumps(final)}\n\n")
        if request.url.path == "/admin/agent-runs":
            return httpx.Response(200, json={"items": []})
        if request.url.path == "/admin/agent-runs/business-clinical-1/steps":
            return httpx.Response(200, json={"items": [{"node_name": "retrieve_evidence", "status": "completed"}]})
        return httpx.Response(404)

    monkeypatch.setattr(adapters, "_client", lambda base_url, timeout: httpx.Client(
        base_url=base_url, transport=httpx.MockTransport(handler)))
    store = Store(config)
    case = next(c for c in store.list_cases("clinical") if c["category"] == "medication")
    store.create_batch([case["case_id"]], "clinical-adapter-contract")
    run = store.claim_next("worker-test")
    assert run
    output = adapters.run_clinical(run, case, config, store)
    assert "POST /chat/stream" in requested
    assert requested.index("GET /auth/me") < requested.index("POST /chat/stream")
    assert output["model_evidence"]["calls"] == 1
    assert store.get_run(run["run_id"])["business_run_id"] == "business-clinical-1"
    assert any(e["node"] == "retrieve_evidence" for e in store.events(run["run_id"]))


def test_clinical_context_case_uses_synthetic_case_and_prior_turn(tmp_path: Path, monkeypatch) -> None:
    config = settings(tmp_path)
    requested: list[str] = []
    usage = {"successful_request_count": 1, "events": [{"model_name": "qwen-test", "status": "success"}]}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        requested.append(f"{request.method} {path}")
        if path == "/auth/register":
            return httpx.Response(200, json={"user": {"user_id": "synthetic-clinician"}})
        if path == "/auth/login":
            return httpx.Response(200, json={"access_token": "synthetic-token"})
        if path == "/auth/me":
            return httpx.Response(200, json={"user": {"user_id": "synthetic-clinician"}})
        if path == "/cases":
            assert request.headers["authorization"] == "Bearer synthetic-token"
            return httpx.Response(200, json={"case_id": "case-synthetic-1"})
        if path == "/cases/case-synthetic-1/import-text":
            return httpx.Response(200, json={"status": "imported"})
        if path == "/chat":
            body = json.loads(request.content)
            assert body["case_id"] == "case-synthetic-1"
            return httpx.Response(200, json={"run_id": "setup-1", "trace": {"model_usage": usage}})
        if path == "/chat/stream":
            body = json.loads(request.content)
            assert body["case_id"] == "case-synthetic-1"
            final = {"type": "final", "response": {"run_id": "final-1", "trace": {
                "case_context_used": True, "needs_retrieval": True, "model_usage": usage}}}
            return httpx.Response(200, text=f"data: {json.dumps(final)}\n\n")
        if path == "/admin/agent-runs":
            return httpx.Response(200, json={"items": []})
        if path == "/admin/agent-runs/final-1/steps":
            return httpx.Response(200, json={"items": []})
        return httpx.Response(404)

    monkeypatch.setattr(adapters, "_client", lambda base_url, timeout: httpx.Client(
        base_url=base_url, transport=httpx.MockTransport(handler)))
    store = Store(config)
    case = next(c for c in store.list_cases("clinical") if c["category"] == "context")
    store.create_batch([case["case_id"]], "clinical-context-contract")
    run = store.claim_next("worker-test")
    assert run
    output = adapters.run_clinical(run, case, config, store)
    assert requested.index("POST /chat") < requested.index("POST /chat/stream")
    assert output["model_evidence"]["main_calls"] == 1
    assert output["model_evidence"]["setup_calls"] == 1
    assert store.get_run(run["run_id"])["model_calls"] == 2
    assert any(e["node"] == "clinical.case_context" for e in store.events(run["run_id"]))


def test_wrong_rag_material_requires_gold_source_and_links_evidence(tmp_path: Path) -> None:
    dataset = tmp_path / "datasets"
    dataset.mkdir()
    source_case = {"case_id": "clinical_gold_rag_v1", "agent": "clinical", "category": "evidence",
                   "title": "合成资料选择", "message": "虚构病例：依据指定合成指南回答。", "synthetic": True,
                   "expected": {"must_retrieve": True, "source_ids": ["doc-correct"], "required_model_calls": 1},
                   "gold_status": "engineering_draft"}
    (dataset / "gold.jsonl").write_text(json.dumps(source_case, ensure_ascii=False) + "\n", encoding="utf-8")
    store = Store(replace(settings(tmp_path), dataset_root=dataset))
    store.create_batch([source_case["case_id"]], "rag-gold")
    run = store.claim_next("worker-test")
    assert run
    output = {"result": {"trace": {"needs_retrieval": True, "retrieval_candidate_count": 3,
                                   "selected_sources": [{"document_id": "doc-wrong"}],
                                   "evidence_sufficient": True}}}
    store.set_run_fields(run["run_id"], status="completed", output_json=dumps(output), model_calls=1,
                         model_evidence_json=dumps({"verified": True, "calls": 1}), finished_at=now())
    diagnosis = evaluate_run(store, run["run_id"])
    wrong = next(f for f in diagnosis["findings"] if f["dimension"] == "source_selection")
    assert wrong["status"] == "fail"
    assert wrong["evidence"] == ["case.expected.source_ids", "output.result.trace.selected_sources"]
    assert diagnosis["first_failure"]["dimension"] == "source_selection"
