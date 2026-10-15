from __future__ import annotations

import hashlib
import logging
import os
import threading
from uuid import uuid4

import httpx

from agent_evo.adapters import AgentRunError, _unihr_usage, run_clinical, run_unihr
from agent_evo.config import Settings
from agent_evo.evaluation import evaluate_run
from agent_evo.store import Store, dumps, now
from agent_evo.generic_adapter import target_settings, run_generic
from agent_evo.conversation import run_conversation


log = logging.getLogger(__name__)


def execute_business(run: dict, store: Store, settings: Settings) -> None:
    case = store.get_case(run["case_id"])
    run_id = run["run_id"]
    store.add_event(run_id, "platform", "runner.start", "running",
                    {"case_id": case["case_id"], "agent": case["agent"], "trace_id": run["trace_id"]})
    try:
        if run.get("execution_mode") == "recorded":
            output = run.get("output") or {}
            okay = output.get("business_status") == "succeeded"
            store.set_run_fields(run_id, status="completed" if okay else "failed", finished_at=now(),
                                 error_code=None if okay else "recorded_business_incomplete")
            store.add_event(run_id, "recording", "recording.evaluation", "completed",
                            {"new_business_calls": 0, "historical_model_calls": run["model_calls"]})
            try:
                evaluate_run(store, run_id)
            except Exception:
                # A scoring failure must never replace an immutable native snapshot.
                log.exception("Recorded evaluation failed for run %s", run_id)
                store.set_run_fields(run_id, error_code="recording_evaluator_error")
                store.add_event(run_id, "evaluation", "diagnosis", "failed", {"error_code": "evaluator_error", "native_snapshot_preserved": True})
            return
        fixture_hashes = {}
        from agent_evo.recordings import assert_replayable
        assert_replayable(case)
        for relative in case.get("fixtures", []):
            path = (settings.fixture_root / relative).resolve()
            if settings.fixture_root.resolve() not in path.parents or not path.is_file():
                raise AgentRunError("invalid_fixture", "Fixture must be an existing file under fixtures")
            fixture_hashes[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        store.add_event(run_id, "platform", "runner.inputs", "completed",
                        {"case_sha256": run["case_sha256"], "fixture_sha256": fixture_hashes})
        store.set_run_fields(run_id, version_json=dumps({"case_sha256": run["case_sha256"],
                                                         "fixture_sha256": fixture_hashes}))
        run = store.get_run(run_id)
        target = run["agent_snapshot"]
        settings = target_settings(settings, target)
        adapter = {"unihr": run_unihr, "clinical": run_clinical, "http_json": run_generic}[target["adapter_kind"]]
        output = run_conversation(run, case, settings, store) if case.get("turns") else adapter(run, case, settings, store)
        business_ok = output.get("business_status") == "succeeded"
        store.set_run_fields(run_id, status="completed" if business_ok else "failed",
                             output_json=dumps(output), error_code=None if business_ok else str(output.get("error_code") or "business_failed"),
                             finished_at=now())
        store.add_event(run_id, "platform", "runner.finish", "completed" if business_ok else "failed",
                        {"business_status": output.get("business_status")})
    except (AgentRunError, httpx.HTTPError, OSError, ValueError) as exc:
        latest = store.get_run(run_id)
        if case["agent"] == "unihr" and latest.get("business_execution_id"):
            usage = _unihr_usage(settings.unihr_usage_db, latest["business_execution_id"])
            store.set_run_fields(run_id, model_calls=int(usage.get("calls", 0)),
                                 model_evidence_json=dumps(usage))
        code = exc.code if isinstance(exc, AgentRunError) else type(exc).__name__
        status = "timed_out" if code in {"unihr_timeout", "clinical_timeout", "ReadTimeout", "ConnectTimeout"} else "blocked" if code in {
            "unihr_credentials_missing", "unihr_usage_unconfigured", "nonlocal_target", "invalid_fixture"
        } else "failed"
        store.set_run_fields(run_id, status=status, error_code=code,
                             output_json=dumps({"error": str(exc), "error_type": type(exc).__name__}), finished_at=now())
        store.add_event(run_id, "platform", "runner.finish", status,
                        {"error_code": code, "message": str(exc)})
    except Exception as exc:
        log.exception("Unexpected failure in run %s", run_id)
        store.set_run_fields(run_id, status="failed", error_code="internal_runner_error",
                             output_json=dumps({"error_type": type(exc).__name__}), finished_at=now())
        store.add_event(run_id, "platform", "runner.finish", "failed", {"error_code": "internal_runner_error"})
    try:
        evaluate_run(store, run_id)
    except Exception:
        log.exception("Evaluation failed for run %s", run_id)
        store.add_event(run_id, "evaluation", "diagnosis", "failed", {"error_code": "evaluator_error"})


def execute_one(run: dict, store: Store, settings: Settings, stop_event=None) -> None:
    from agent_evo.script_store import binding
    if binding(store, run['run_id']):
        from agent_evo.script_runtime import execute_script
        execute_script(run, store, settings, stop_event=stop_event)
    else:
        execute_business(run, store, settings)


class Worker:
    def __init__(self, store: Store, settings: Settings):
        self.store = store
        self.settings = settings
        self.worker_id = f"worker_{uuid4().hex[:12]}"
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._loop, name="agent-evo-runner", daemon=True)

    def start(self) -> None:
        self.store.mark_interrupted()
        with self.store.connect() as db:
            db.execute("UPDATE script_runs SET process_status='interrupted',evaluator_status=CASE WHEN evaluator_status='pending' THEN 'interrupted' ELSE evaluator_status END WHERE process_status='running'")
            db.execute("UPDATE scoring_jobs SET status='interrupted',finished_at=? WHERE status='running'", (now(),))
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=5)

    def _loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                self.store.heartbeat(self.worker_id)
                with self.store.connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    score_job = db.execute("SELECT * FROM scoring_jobs WHERE status='queued' ORDER BY created_at LIMIT 1").fetchone() if os.getenv('EVO_LOCAL_SCRIPTS_ENABLED', '1').lower() not in {'0', 'false'} else None
                    if score_job:
                        db.execute("UPDATE scoring_jobs SET status='running' WHERE job_id=?", (score_job['job_id'],))
                if score_job:
                    from agent_evo.script_runtime import execute_script
                    from agent_evo.script_store import binding
                    execute_script(self.store.get_run(score_job['run_id']), self.store, self.settings, rescore=True, stop_event=self.stop_event)
                    with self.store.connect() as db:
                        db.execute('UPDATE scoring_jobs SET status=?,finished_at=? WHERE job_id=?', (binding(self.store, score_job['run_id'])['evaluator_status'], now(), score_job['job_id']))
                    continue
                claimed = self.store.claim_next(self.worker_id)
                if claimed is None:
                    self.stop_event.wait(1)
                else:
                    execute_one(claimed, self.store, self.settings, stop_event=self.stop_event)
            except Exception:
                log.exception("Runner loop error")
                self.stop_event.wait(2)
