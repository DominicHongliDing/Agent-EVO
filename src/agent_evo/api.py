from __future__ import annotations

import json
import sqlite3
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from agent_evo.config import Settings
from agent_evo.models import CreateBatch, ReviewInput, AgentInput, DatasetInput, RenameInput, AssignDatasets, ManageBatches, RetrySelection
from agent_evo.management import preview_dataset
from agent_evo.runner import Worker
from agent_evo.store import Store
from agent_evo.recordings import RecordingInput, import_recording
from agent_evo.clinical_scope import clinical_batch


class RegressionInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    expectation: str = Field(min_length=1, max_length=4000)


class AssessmentInput(BaseModel):
    mode: str = Field(pattern='^(quality|diagnosis)$')


def create_app(settings: Settings | None = None, *, start_worker: bool = True) -> FastAPI:
    settings = settings or Settings.from_env()
    settings.assert_local_targets()
    store = Store(settings)
    worker = Worker(store, settings) if start_worker else None
    from agent_evo.langfuse_sync import SyncWorker
    sync = SyncWorker(store)
    from agent_evo.answer_imports import migrate as migrate_answers
    from agent_evo.answer_judge import AnswerJudge
    migrate_answers(store)
    answer_judge = AnswerJudge(store)
    from agent_evo.report_api import ReportWorker, install as install_reports
    report_worker = ReportWorker(store, answer_judge)
    from agent_evo.workbench_api import Workbench
    workbench = Workbench(settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if worker:
            workbench.start()
            worker.start()
            sync.start()
            answer_judge.start()
            report_worker.start()
        yield
        if worker:
            workbench.stop()
            worker.stop()
            sync.stop()
            answer_judge.stop()
            report_worker.stop()

    app = FastAPI(title="Agent EVO", version="0.1.0", lifespan=lifespan)
    app.state.store = store
    app.state.sync = sync
    from agent_evo.script_api import install_script_api
    install_script_api(app, store, sync)

    async def local_access(request: Request) -> None:
        if settings.access_token:
            supplied = request.headers.get("X-EVO-Token", "")
            if supplied != settings.access_token:
                raise HTTPException(401, "invalid platform token")
        elif request.client is None or request.client.host not in {"127.0.0.1", "::1", "localhost", "testclient"}:
            raise HTTPException(403, "platform accepts local clients only")

    workbench.install(app, local_access)
    protected = [Depends(local_access)]
    from agent_evo.answer_api import install as install_answers
    install_answers(app, store, answer_judge, local_access)
    app.state.answer_judge = answer_judge
    install_reports(app, report_worker, local_access)
    app.state.report_worker = report_worker
    from agent_evo.decision_api import install as install_decisions
    install_decisions(app, store, local_access)
    builtins = {"agent_clinical"}

    def require_builtin(agent_id: str | None) -> None:
        if agent_id and agent_id not in builtins:
            raise HTTPException(403, "当前仅开放 Clinical 示例，新增 Agent 暂停")

    @app.api_route("/api/visitor/{path:path}", methods=["GET", "POST", "DELETE"], dependencies=protected)
    async def visitor_gateway(path: str, request: Request):
        from fastapi.responses import StreamingResponse
        allowed = {"providers": {"GET"}, "health": {"GET"}, "credentials/validate": {"POST"},
                   "sessions": {"POST", "DELETE"}, "runs": {"POST"}}
        if request.method not in allowed.get(path, set()):
            raise HTTPException(404, "unsupported visitor route")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > 5_242_880:
                raise HTTPException(413, "文件超过 5 MiB")
        if path == 'sessions' and request.method == 'POST':
            try:
                if json.loads(body).get('project') != 'clinical':
                    raise HTTPException(403, '当前只提供 Clinical 示例')
            except (ValueError, AttributeError):
                raise HTTPException(422, '业务会话参数无效') from None
        headers = {name: request.headers[name] for name in ("content-type", "authorization") if name in request.headers}
        client = httpx.AsyncClient(timeout=120, trust_env=False, follow_redirects=False)
        try:
            upstream = await client.send(client.build_request(request.method, "https://api.dominicspace.com/" + path,
                                                             content=bytes(body), headers=headers), stream=True)
        except httpx.HTTPError:
            await client.aclose()
            raise HTTPException(502, "暂时无法连接 Clinical 业务服务") from None
        if 300 <= upstream.status_code < 400:
            await upstream.aclose(); await client.aclose()
            raise HTTPException(502, "业务服务发生跳转，请检查服务地址")
        async def stream():
            try:
                async for chunk in upstream.aiter_bytes():
                    yield chunk
            finally:
                await upstream.aclose(); await client.aclose()
        return StreamingResponse(stream(), status_code=upstream.status_code,
                                 headers={"Content-Type": upstream.headers.get("content-type", "application/json"),
                                          "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})

    async def recording_access(request: Request) -> None:
        token = os.getenv("EVO_RECORDING_TOKEN", "")
        if token:
            if request.headers.get("X-EVO-Recording-Token", "") != token:
                raise HTTPException(401, "invalid recording token")
        else:
            await local_access(request)

    @app.post("/api/recordings", dependencies=[Depends(recording_access)], status_code=201)
    def recording(payload: RecordingInput) -> dict:
        require_builtin(payload.agent_id)
        try:
            return import_recording(store, payload)
        except KeyError as exc:
            raise HTTPException(404, "来源 Agent 未接入") from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    def found_run(run_id: str) -> dict:
        try:
            result = store.get_run(run_id)
            if store.get_case(result['case_id'])['agent'] != 'clinical':
                raise KeyError(run_id)
            return result
        except KeyError as exc:
            raise HTTPException(404, "run not found") from exc

    @app.get("/api/health", dependencies=protected)
    def health() -> dict:
        services = {}
        for name, url in (("clinical", settings.clinical_url),):
            try:
                response = httpx.get(f"{url}/health", timeout=2.0, trust_env=False)
                services[name] = {"reachable": response.status_code < 500,
                                  "http_status": response.status_code, "base_url": url}
            except httpx.HTTPError as exc:
                services[name] = {"reachable": False, "error": type(exc).__name__, "base_url": url}
        return {"platform": "ready", "worker": store.worker_status(), "services": services,
                "clinical_validation": "engineering_only"}

    @app.get("/api/cases", dependencies=protected)
    def cases(agent: str | None = None, dataset_id: str | None = None) -> dict:
        if agent and agent not in {'clinical', 'generic'}:
            return {"items": [], "total": 0}
        items = [c for c in store.list_cases(agent, dataset_id) if c['agent'] in {'clinical', 'generic'}]
        return {"items": items, "total": len(items)}

    @app.post("/api/batches", dependencies=protected, status_code=201)
    def create_batch(payload: CreateBatch) -> dict:
        require_builtin(payload.agent_id)
        try:
            if any(store.get_case(case_id)["agent"] != "clinical" for case_id in payload.case_ids):
                raise HTTPException(403, "当前仅开放 Clinical 示例")
            return store.create_batch(payload.case_ids, payload.label, payload.agent_id, payload.dataset_id, payload.repetitions)
        except (KeyError, ValueError) as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/api/batches", dependencies=protected)
    def batches(deleted: bool = False) -> dict:
        return {"items": [b for b in map(clinical_batch, store.list_batches(deleted)) if b['total']]}

    def operation(fn, *, conflict=False):
        try:
            return fn()
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409 if conflict else 400, str(exc)) from exc

    @app.get("/api/agents", dependencies=protected)
    def agents(deleted: bool = False) -> dict:
        return {"items": [a for a in store.list_agents(deleted) if a["agent_id"] in builtins]}

    @app.post("/api/agents", dependencies=protected, status_code=201)
    def add_agent(payload: AgentInput) -> dict:
        raise HTTPException(403, "当前使用 Clinical 内置示例，不开放新增 Agent")

    @app.patch("/api/agents/{agent_id}", dependencies=protected)
    def edit_agent(agent_id: str, payload: AgentInput) -> dict:
        raise HTTPException(403, "Agent 配置已锁定")

    @app.post("/api/agents/{agent_id}/check", dependencies=protected)
    def check_agent(agent_id: str) -> dict:
        require_builtin(agent_id)
        from agent_evo.management import validate_target
        agent = operation(lambda: store.get_agent(agent_id))
        operation(lambda: validate_target(agent))
        try:
            response = httpx.get(agent["base_url"] + "/health", timeout=3, follow_redirects=False, trust_env=False)
            return {"reachable": 200 <= response.status_code < 300, "http_status": response.status_code, "model_verified": False}
        except httpx.HTTPError as exc:
            return {"reachable": False, "error": type(exc).__name__, "model_verified": False}

    @app.put("/api/agents/{agent_id}/datasets", dependencies=protected)
    def assign(agent_id: str, payload: AssignDatasets) -> dict:
        require_builtin(agent_id)
        for dataset_id in payload.dataset_ids:
            clinical_dataset(dataset_id)
        return operation(lambda: store.assign_datasets(agent_id, payload.dataset_ids))

    @app.post("/api/agents/{agent_id}/delete", dependencies=protected)
    def delete_agent(agent_id: str) -> dict:
        raise HTTPException(403, "预置 Agent 不可删除")

    @app.post("/api/agents/{agent_id}/restore", dependencies=protected)
    def restore_agent(agent_id: str) -> dict:
        require_builtin(agent_id)
        operation(lambda: store.change_entity_state("agent", agent_id, True))
        return {"restored": True}

    @app.get("/api/datasets", dependencies=protected)
    def datasets(deleted: bool = False) -> dict:
        return {"items": [d for d in store.list_datasets(deleted) if d['profile'] in {'clinical', 'generic'}]}

    @app.post("/api/datasets/preview", dependencies=protected)
    def dataset_preview(payload: DatasetInput) -> dict:
        if payload.profile not in {'clinical', 'generic'}:
            raise HTTPException(422, '请选择 Clinical 或通用问答测试集')
        result = preview_dataset(payload, settings.fixture_root)
        result.pop("cases")
        return result

    @app.post("/api/datasets", dependencies=protected, status_code=201)
    def add_dataset(payload: DatasetInput) -> dict:
        if payload.profile not in {'clinical', 'generic'}:
            raise HTTPException(422, '请选择 Clinical 或通用问答测试集')
        item = operation(lambda: store.import_dataset(payload))
        if payload.profile == 'clinical':
            with store.connect() as db:
                db.execute('INSERT OR IGNORE INTO agent_datasets VALUES(?,?)', ('agent_clinical', item['dataset_id']))
        return item

    def clinical_dataset(dataset_id):
        with store.connect() as db:
            row = db.execute("SELECT profile FROM datasets WHERE dataset_id=?", (dataset_id,)).fetchone()
        if not row or row[0] != 'clinical':
            raise HTTPException(404, '测试集不存在')

    def visible_dataset(dataset_id):
        with store.connect() as db:
            row = db.execute('SELECT profile FROM datasets WHERE dataset_id=?', (dataset_id,)).fetchone()
        if not row or row[0] not in {'clinical', 'generic'}:
            raise HTTPException(404, '测试集不存在')

    @app.patch("/api/datasets/{dataset_id}", dependencies=protected)
    def rename_dataset(dataset_id: str, payload: RenameInput) -> dict:
        visible_dataset(dataset_id)
        return operation(lambda: store.rename_dataset(dataset_id, payload.name))

    @app.post("/api/datasets/{dataset_id}/delete", dependencies=protected)
    def delete_dataset(dataset_id: str) -> dict:
        visible_dataset(dataset_id)
        operation(lambda: store.change_entity_state("dataset", dataset_id), conflict=True)
        return {"deleted": True}

    @app.post("/api/datasets/{dataset_id}/restore", dependencies=protected)
    def restore_dataset(dataset_id: str) -> dict:
        visible_dataset(dataset_id)
        operation(lambda: store.change_entity_state("dataset", dataset_id, True))
        return {"restored": True}

    @app.post("/api/batches/manage", dependencies=protected)
    def manage_batches(payload: ManageBatches) -> dict:
        for batch_id in payload.batch_ids:
            batch(batch_id)
        operation(lambda: store.manage_batches(payload.batch_ids, payload.action), conflict=True)
        return {"updated": len(payload.batch_ids), "action": payload.action}

    @app.get("/api/batches/{batch_id}/failures", dependencies=protected)
    def failures(batch_id: str, dimension: str | None = None, critical: bool = False, q: str = "") -> dict:
        batch(batch_id)
        result = operation(lambda: store.failures(batch_id, dimension, critical, q))
        rows = [r for r in result['items'] if r['agent'] == 'clinical']
        return {**result, 'items': rows, 'total': len(rows), 'assertion_count': sum(len(r['findings']) for r in rows)}

    @app.post("/api/batches/{batch_id}/retry-selected", dependencies=protected, status_code=201)
    def retry_selection(batch_id: str, payload: RetrySelection) -> dict:
        for run_id in payload.run_ids:
            require_builtin(found_run(run_id).get("agent_id"))
        return operation(lambda: store.retry_selected(batch_id, payload.run_ids), conflict=True)

    @app.get("/api/batches/{batch_id}", dependencies=protected)
    def batch(batch_id: str) -> dict:
        try:
            result = clinical_batch(store.get_batch(batch_id))
            if not result['total']:
                raise KeyError(batch_id)
            return result
        except KeyError as exc:
            raise HTTPException(404, "batch not found") from exc

    @app.get("/api/batches/{batch_id}/report", dependencies=protected)
    def batch_report(batch_id: str) -> dict:
        batch_data = batch(batch_id)
        by_agent: dict[str, dict[str, int]] = {}
        dimensions: dict[str, dict[str, int]] = {}
        critical_failures = []
        for item in batch_data["runs"]:
            agent = item["agent"]
            agent_counts = by_agent.setdefault(agent, {"total": 0, "completed": 0, "model_verified": 0,
                                                       "failed_or_blocked": 0})
            agent_counts["total"] += 1
            agent_counts["completed"] += item["status"] == "completed"
            agent_counts["model_verified"] += bool(item["live_model_verified"])
            agent_counts["failed_or_blocked"] += item["status"] in {"failed", "blocked", "timed_out"}
            from agent_evo.evidence import latest_verdicts
            for verdict in latest_verdicts(store.verdicts(item["run_id"])):
                if verdict["evaluator"] not in {"deterministic-v1", "context-llm-v1"}:
                    continue
                counts = dimensions.setdefault(verdict["dimension"], {"pass": 0, "fail": 0, "unjudged": 0})
                counts[verdict["result"]] += 1
                if verdict["critical"] and verdict["result"] == "fail":
                    critical_failures.append({"run_id": item["run_id"], "case_id": item["case_id"],
                                              "dimension": verdict["dimension"], "rationale": verdict["rationale"]})
        return {"batch_id": batch_id, "total": batch_data["total"], "finished": batch_data["finished"],
                "by_agent": by_agent, "dimensions": dimensions, "critical_failures": critical_failures,
                "clinical_validation": "not_performed"}

    @app.get("/api/runs", dependencies=protected)
    def runs(batch_id: str | None = None, limit: int = 200, case_id: str | None = None) -> dict:
        with store.connect() as db:
            ids = db.execute("SELECT r.run_id FROM runs r JOIN cases c USING(case_id) JOIN batches b USING(batch_id) WHERE c.agent='clinical' AND b.deleted_at IS NULL AND (? IS NULL OR r.batch_id=?) AND (? IS NULL OR r.case_id=?) ORDER BY r.rowid DESC LIMIT ?", (batch_id, batch_id, case_id, case_id, min(max(limit, 1), 500))).fetchall()
        return {"items": [store.get_run(r[0]) for r in ids]}

    @app.get("/api/runs/{run_id}", dependencies=protected)
    def run(run_id: str) -> dict:
        item = found_run(run_id)
        item["case"] = store.get_case(item["case_id"])
        item["events"] = store.events(run_id)
        item["artifacts"] = [{k: v for k, v in a.items() if k != "local_path"} for a in store.artifacts(run_id)]
        item["verdicts"] = store.verdicts(run_id)
        return item

    @app.get('/api/runs/{run_id}/evidence', dependencies=protected)
    def evidence_overview(run_id: str):
        from agent_evo.evidence import summary
        return summary(run(run_id))

    @app.get('/api/runs/{run_id}/evidence/search', dependencies=protected)
    def evidence_search(run_id: str, q: str):
        from agent_evo.evidence import trace_search
        return operation(lambda: trace_search(run(run_id), q))

    @app.get('/api/runs/{run_id}/evidence/detail', dependencies=protected)
    def evidence_detail(run_id: str, ref: str):
        from agent_evo.evidence import trace_detail
        return operation(lambda: trace_detail(run(run_id), ref))

    @app.get('/api/batches/{batch_id}/stability', dependencies=protected)
    def batch_stability(batch_id: str):
        from agent_evo.evidence import stability
        return stability(store, batch(batch_id))

    @app.get('/api/evidence/compare', dependencies=protected)
    def evidence_compare(left: str, right: str):
        from agent_evo.evidence import compare_records
        return compare_records(run(left), run(right))

    @app.post('/api/runs/{run_id}/regression', dependencies=protected, status_code=201)
    def regression(run_id: str, payload: RegressionInput):
        from uuid import uuid4
        item = run(run_id)
        case = {k: v for k, v in item['case'].items() if k not in {'sha256', 'dataset_id'}}
        case.update(case_id='regression_' + uuid4().hex, gold_status='engineering_draft')
        case['expected'] = {**case.get('expected', {}), 'behavior_expectation': payload.expectation,
                            'regression_of': run_id, 'source_case_sha256': item['case_sha256']}
        # Preserve source inputs exactly; this is a provenance-linked copy,
        # not a synthetic rewrite of a historical user message.
        from agent_evo.models import EvalCase, case_payload
        from agent_evo.store import dumps
        import hashlib
        normalized = case_payload(EvalCase.model_validate(case))
        dataset_id = 'dataset_' + uuid4().hex
        digest = hashlib.sha256(dumps(normalized).encode()).hexdigest()
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT INTO datasets(dataset_id,name,profile,version,content_sha256,created_at,description,source_filename) VALUES(?,?,?,?,?,?,?,?)',
                       (dataset_id, payload.name, 'clinical', 'v1', digest, datetime.now(timezone.utc).isoformat(), '由失败记录建立；期望待审核', 'regression.jsonl'))
            db.execute('INSERT INTO cases(case_id,agent,category,suite_version,risk_level,content_sha256,data_json,dataset_id) VALUES(?,?,?,?,?,?,?,?)',
                       (case['case_id'], 'clinical', case['category'], case['suite_version'], case['risk_level'], digest, dumps(normalized), dataset_id))
            db.execute('INSERT INTO agent_datasets VALUES(?,?)', ('agent_clinical', dataset_id))
        store.add_event(run_id, 'review', 'regression.created', 'completed', {'dataset_id': dataset_id, 'case_id': case['case_id']})
        return store.get_dataset(dataset_id)

    @app.get('/api/runs/{run_id}/assessments', dependencies=protected)
    def assessments(run_id: str):
        item = run(run_id)
        return {'items': [e['payload'] for e in item['events'] if e['node'] == 'assessment.result']}

    @app.post('/api/runs/{run_id}/assessments', dependencies=protected)
    def assessment(run_id: str, payload: AssessmentInput):
        item = run(run_id)
        if item['status'] in {'queued', 'running'}:
            raise HTTPException(409, '请等本条执行结束后再评审')
        from agent_evo.assessment import assess
        return assess(store, item, payload.mode)

    @app.get("/api/runs/{run_id}/events", dependencies=protected)
    def events(run_id: str, after: int = 0) -> dict:
        found_run(run_id)
        return {"items": store.events(run_id, after)}

    @app.post("/api/runs/{run_id}/cancel", dependencies=protected)
    def cancel(run_id: str) -> dict:
        found_run(run_id)
        if not store.cancel_queued(run_id):
            raise HTTPException(409, "only queued runs can be cancelled")
        return store.get_run(run_id)

    @app.post("/api/runs/{run_id}/retry", dependencies=protected, status_code=201)
    def retry(run_id: str) -> dict:
        require_builtin(found_run(run_id).get("agent_id"))
        try:
            return store.retry(run_id)
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/runs/{run_id}/review", dependencies=protected, status_code=201)
    def review(run_id: str, payload: ReviewInput) -> dict:
        found_run(run_id)
        store.add_verdict(run_id, payload.dimension, "human", payload.result,
                          payload.rationale, [f"run:{run_id}"], reviewer=payload.reviewer)
        store.add_event(run_id, "review", payload.dimension, payload.result,
                        {"reviewer": payload.reviewer, "rationale": payload.rationale})
        return {"items": store.verdicts(run_id)}

    @app.get("/api/runs/{run_id}/artifacts/{artifact_id}", dependencies=protected)
    def artifact(run_id: str, artifact_id: str) -> FileResponse:
        found_run(run_id)
        try:
            item = store.get_artifact(run_id, artifact_id)
        except KeyError as exc:
            raise HTTPException(404, "artifact not found") from exc
        path = Path(item["local_path"]).resolve()
        if settings.artifact_root.resolve() not in path.parents or not path.is_file():
            raise HTTPException(404, "artifact file missing")
        return FileResponse(path, filename=item["filename"], media_type=item["mime_type"])

    @app.get("/api/compare", dependencies=protected)
    def compare(left: str, right: str) -> dict:
        a, b = found_run(left), found_run(right)
        def fixture_hashes(run_id: str) -> dict | None:
            found = next((e for e in store.events(run_id) if e["node"] == "runner.inputs"), None)
            item = found_run(run_id)
            if item.get("execution_mode") == "recorded" and not (item.get("output") or {}).get("recording", {}).get("requires_attachments", True):
                return {}
            return found["payload"].get("fixture_sha256") if found else None

        a_fixtures, b_fixtures = fixture_hashes(left), fixture_hashes(right)
        comparable = (a["case_id"] == b["case_id"] and a["case_sha256"] == b["case_sha256"]
                      and a_fixtures is not None and a_fixtures == b_fixtures)
        return {"comparable": comparable,
                "reason": None if comparable else "case or fixture hash differs, or fixture evidence is missing",
                "left": {"run": a, "verdicts": store.verdicts(left)},
                "right": {"run": b, "verdicts": store.verdicts(right)}}

    dist = Path(os.getenv("EVO_WEB_DIST_PATH", str(Path(__file__).resolve().parents[2] / "web" / "dist")))
    if dist.is_dir():
        app.mount("/", StaticFiles(directory=dist, html=True), name="web")
    return app


def create_preview_app() -> FastAPI:
    """UI verification against an isolated copy; never executes copied queue entries."""
    return create_app(start_worker=False)


app = create_app()
