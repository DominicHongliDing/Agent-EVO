from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from uuid import uuid4

from agent_evo.config import Settings
from agent_evo.models import EvalCase, case_payload
from agent_evo.management import Management, migrate_registry


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


class Store(Management):
    def __init__(self, settings: Settings):
        self.settings = settings
        settings.prepare()
        self._init()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.settings.db_path, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=30000")
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def _init(self) -> None:
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS cases (
                    case_id TEXT PRIMARY KEY, agent TEXT NOT NULL, category TEXT NOT NULL,
                    suite_version TEXT NOT NULL, risk_level TEXT NOT NULL,
                    content_sha256 TEXT NOT NULL, data_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS batches (
                    batch_id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(batch_id),
                    case_id TEXT NOT NULL REFERENCES cases(case_id), trace_id TEXT NOT NULL,
                    status TEXT NOT NULL, started_at TEXT, finished_at TEXT,
                    business_execution_id TEXT, business_run_id TEXT,
                    model_calls INTEGER NOT NULL DEFAULT 0, model_evidence_json TEXT NOT NULL DEFAULT '{}',
                    output_json TEXT, error_code TEXT, version_json TEXT NOT NULL DEFAULT '{}',
                    worker_id TEXT, case_sha256 TEXT NOT NULL, retry_of TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_runs_batch ON runs(batch_id);
                CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
                CREATE TABLE IF NOT EXISTS events (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id),
                    span_id TEXT NOT NULL, parent_span_id TEXT, kind TEXT NOT NULL,
                    node TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
                CREATE TABLE IF NOT EXISTS artifacts (
                    artifact_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
                    source_id TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL,
                    byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, local_path TEXT NOT NULL,
                    checks_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS verdicts (
                    verdict_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
                    dimension TEXT NOT NULL, evaluator TEXT NOT NULL, result TEXT NOT NULL,
                    critical INTEGER NOT NULL DEFAULT 0, rationale TEXT NOT NULL,
                    evidence_json TEXT NOT NULL, reviewer TEXT, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS worker_state (
                    singleton INTEGER PRIMARY KEY CHECK(singleton=1), worker_id TEXT, seen_at TEXT
                );
            """)
        self.seed_cases()
        migrate_registry(self)
        from agent_evo.script_store import migrate
        migrate(self)
        with self.connect() as db:
            if 'repetitions' not in {r[1] for r in db.execute('PRAGMA table_info(batches)')}:
                db.execute('ALTER TABLE batches ADD COLUMN repetitions INTEGER NOT NULL DEFAULT 1')
            if 'repetition_index' not in {r[1] for r in db.execute('PRAGMA table_info(runs)')}:
                db.execute('ALTER TABLE runs ADD COLUMN repetition_index INTEGER NOT NULL DEFAULT 1')
            db.execute("CREATE TABLE IF NOT EXISTS recordings (recording_key TEXT PRIMARY KEY, content_sha256 TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(run_id), created_at TEXT NOT NULL)")

    def seed_cases(self) -> None:
        for path in sorted(self.settings.dataset_root.glob("*.jsonl")):
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                case = EvalCase.model_validate_json(line)
                content = case_payload(case)
                digest = hashlib.sha256(dumps(content).encode()).hexdigest()
                with self.connect() as db:
                    row = db.execute("SELECT content_sha256 FROM cases WHERE case_id=?", (case.case_id,)).fetchone()
                    if row is not None and row["content_sha256"] != digest:
                        raise ValueError(f"Frozen case changed without a new case_id: {case.case_id}")
                    db.execute(
                        "INSERT OR IGNORE INTO cases(case_id,agent,category,suite_version,risk_level,content_sha256,data_json) VALUES(?,?,?,?,?,?,?)",
                        (case.case_id, case.agent, case.category, case.suite_version,
                         case.risk_level, digest, dumps(content)),
                    )

    def list_cases(self, agent: str | None = None, dataset_id: str | None = None) -> list[dict]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT c.data_json,c.content_sha256,c.dataset_id FROM cases c JOIN datasets d USING(dataset_id) "
                "WHERE d.deleted_at IS NULL AND (? IS NULL OR c.agent=?) AND (? IS NULL OR c.dataset_id=?) ORDER BY c.agent,c.category,c.case_id",
                (agent, agent, dataset_id, dataset_id),
            ).fetchall()
        return [{**json.loads(r["data_json"]), "sha256": r["content_sha256"], "dataset_id": r["dataset_id"]} for r in rows]

    def get_case(self, case_id: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT data_json,content_sha256,dataset_id FROM cases WHERE case_id=?", (case_id,)).fetchone()
        if row is None:
            raise KeyError(case_id)
        return {**json.loads(row["data_json"]), "sha256": row["content_sha256"], "dataset_id": row["dataset_id"]}

    def create_batch(self, case_ids: list[str], label: str, agent_id: str | None = None, dataset_id: str | None = None, repetitions: int = 1) -> dict:
        return self.create_managed_batch(case_ids, label, agent_id, dataset_id, repetitions=repetitions)

    def get_batch(self, batch_id: str) -> dict:
        with self.connect() as db:
            batch = db.execute("SELECT * FROM batches WHERE batch_id=?", (batch_id,)).fetchone()
            if batch is None:
                raise KeyError(batch_id)
            rows = db.execute(
                "SELECT r.run_id,r.case_id,r.status,r.repetition_index,r.retry_of,r.execution_mode,r.model_calls,r.model_evidence_json,r.agent_id,r.dataset_id,r.agent_snapshot_json,c.agent,c.category,c.data_json case_json "
                "FROM runs r JOIN cases c ON c.case_id=r.case_id WHERE r.batch_id=? ORDER BY r.rowid",
                (batch_id,),
            ).fetchall()
        runs = [dict(row) for row in rows]
        for item in runs:
            item["title"] = json.loads(item.pop("case_json"))["title"]
            snapshot = json.loads(item.pop("agent_snapshot_json") or "{}")
            item["agent_name"] = snapshot.get("name", item["agent"])
            item["dataset_name"] = snapshot.get("dataset_name", "历史测试集")
            evidence = json.loads(item.pop("model_evidence_json") or "{}")
            item["live_model_verified"] = (item["execution_mode"] == "live" and item["status"] == "completed" and bool(evidence.get("verified"))
                                           and item["model_calls"] > 0)
        return {**dict(batch), "runs": runs, "total": len(runs),
                "recorded_count": sum(r["execution_mode"] == "recorded" for r in runs),
                "historical_model_calls": sum(r["model_calls"] for r in runs if r["execution_mode"] == "recorded"),
                "finished": sum(r["status"] in {"completed", "failed", "timed_out", "cancelled", "blocked"} for r in runs),
                "live_model_verified": sum(r["live_model_verified"] for r in runs)}

    def list_batches(self, deleted: bool = False) -> list[dict]:
        with self.connect() as db:
            rows = db.execute("SELECT batch_id FROM batches WHERE (deleted_at IS NOT NULL)=? ORDER BY pinned DESC,created_at DESC LIMIT 100", (int(deleted),)).fetchall()
        return [self.get_batch(row["batch_id"]) for row in rows]

    def claim_next(self, worker_id: str) -> dict | None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            scripts_enabled = os.getenv('EVO_LOCAL_SCRIPTS_ENABLED', '1').lower() not in {'0', 'false'}
            row = db.execute("SELECT r.run_id FROM runs r JOIN batches b USING(batch_id) WHERE r.status='queued' AND b.deleted_at IS NULL AND (? OR r.run_id NOT IN (SELECT run_id FROM script_runs)) ORDER BY r.rowid LIMIT 1", (scripts_enabled,)).fetchone()
            if row is None:
                return None
            db.execute(
                "UPDATE runs SET status='running',started_at=?,worker_id=? WHERE run_id=? AND status='queued'",
                (now(), worker_id, row["run_id"]),
            )
            run_id = row["run_id"]
        self.add_event(run_id, "platform", "runner.claim", "running", {"worker_id": worker_id})
        return self.get_run(run_id)

    def heartbeat(self, worker_id: str) -> None:
        with self.connect() as db:
            db.execute("INSERT INTO worker_state(singleton,worker_id,seen_at) VALUES(1,?,?) "
                       "ON CONFLICT(singleton) DO UPDATE SET worker_id=excluded.worker_id,seen_at=excluded.seen_at",
                       (worker_id, now()))

    def mark_interrupted(self) -> list[str]:
        """Never silently retry a business task that may still have side effects."""
        with self.connect() as db:
            rows = db.execute("SELECT run_id FROM runs WHERE status='running'").fetchall()
            run_ids = [row["run_id"] for row in rows]
            db.execute("UPDATE runs SET status='blocked',error_code='interrupted_unknown',finished_at=? "
                       "WHERE status='running'", (now(),))
        for run_id in run_ids:
            self.add_event(run_id, "platform", "runner.recovery", "blocked",
                           {"reason": "worker process ended; check business run before controlled retry"})
        return run_ids

    def worker_status(self) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT worker_id,seen_at FROM worker_state WHERE singleton=1").fetchone()
        return dict(row) if row else {"worker_id": None, "seen_at": None}

    def get_run(self, run_id: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            raise KeyError(run_id)
        result = dict(row)
        for key in ("model_evidence_json", "output_json", "version_json", "agent_snapshot_json"):
            result[key.removesuffix("_json")] = json.loads(result.pop(key) or "null")
        result["agent_name"] = (result.get("agent_snapshot") or {}).get("name", "Agent")
        return result

    def list_runs(self, batch_id: str | None = None, limit: int = 200) -> list[dict]:
        with self.connect() as db:
            rows = db.execute(
                "SELECT r.run_id FROM runs r JOIN batches b USING(batch_id) WHERE b.deleted_at IS NULL AND (? IS NULL OR r.batch_id=?) ORDER BY r.rowid DESC LIMIT ?",
                (batch_id, batch_id, min(max(limit, 1), 500)),
            ).fetchall()
        return [self.get_run(row["run_id"]) for row in rows]

    def cancel_queued(self, run_id: str) -> bool:
        with self.connect() as db:
            result = db.execute(
                "UPDATE runs SET status='cancelled',finished_at=? WHERE run_id=? AND status='queued'",
                (now(), run_id),
            )
        if result.rowcount:
            self.add_event(run_id, "platform", "runner.cancel", "cancelled", {})
        return bool(result.rowcount)

    def retry(self, run_id: str) -> dict:
        prior = self.get_run(run_id)
        if prior["status"] not in {"completed", "failed", "timed_out", "blocked", "cancelled"}:
            raise ValueError("run is not terminal")
        if self.get_batch(prior["batch_id"])["deleted_at"]:
            raise ValueError("请先恢复原批次")
        if self.get_agent(prior["agent_id"])["deleted_at"] or self.get_dataset(prior["dataset_id"])["deleted_at"]:
            raise ValueError("请先恢复原 Agent 与测试集")
        case = self.get_case(prior["case_id"])
        from agent_evo.recordings import assert_replayable
        assert_replayable(case)
        if prior["case_sha256"] != case["sha256"]:
            raise ValueError("case content changed; create a new batch")
        replacement = f"run_{uuid4().hex}"
        with self.connect() as db:
            db.execute(
                "INSERT INTO runs(run_id,batch_id,case_id,trace_id,status,case_sha256,retry_of,agent_id,dataset_id,agent_snapshot_json) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (replacement, prior["batch_id"], prior["case_id"], uuid4().hex,
                 "queued", prior["case_sha256"], run_id, prior["agent_id"], prior["dataset_id"], dumps(prior["agent_snapshot"])),
            )
            db.execute("INSERT INTO script_runs(run_id,script_id,interpreter,timeout_seconds,working_directory) SELECT ?,script_id,interpreter,timeout_seconds,working_directory FROM script_runs WHERE run_id=?", (replacement, run_id))
            db.execute("INSERT INTO sync_exports(run_id,enabled,updated_at) SELECT ?,enabled,? FROM sync_exports WHERE run_id=?", (replacement, now(), run_id))
        self.add_event(replacement, "platform", "runner.retry", "queued", {"retry_of": run_id})
        return self.get_run(replacement)

    def set_run_fields(self, run_id: str, **fields: object) -> None:
        allowed = {"status", "business_execution_id", "business_run_id", "model_calls",
                   "model_evidence_json", "output_json", "error_code", "version_json", "finished_at"}
        if not fields or set(fields) - allowed:
            raise ValueError("invalid run fields")
        with self.connect() as db:
            db.execute(
                f"UPDATE runs SET {','.join(f'{name}=?' for name in fields)} WHERE run_id=?",
                (*fields.values(), run_id),
            )

    def add_event(self, run_id: str, kind: str, node: str, status: str, payload: object,
                  parent_span_id: str | None = None) -> str:
        span_id = uuid4().hex[:16]
        with self.connect() as db:
            db.execute(
                "INSERT INTO events(run_id,span_id,parent_span_id,kind,node,status,payload_json,created_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (run_id, span_id, parent_span_id, kind, node, status, dumps(payload), now()),
            )
        return span_id

    def events(self, run_id: str, after: int = 0) -> list[dict]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq", (run_id, after)).fetchall()
        return [{**dict(r), "payload": json.loads(r["payload_json"])} for r in rows]

    def add_artifact(self, run_id: str, source_id: str, filename: str, mime: str,
                     local_path: Path, checks: dict) -> dict:
        data = local_path.read_bytes()
        item = {"artifact_id": f"art_{uuid4().hex}", "run_id": run_id, "source_id": source_id,
                "filename": filename, "mime_type": mime, "byte_size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(), "local_path": str(local_path),
                "checks": checks}
        with self.connect() as db:
            db.execute("INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)",
                       (item["artifact_id"], run_id, source_id, filename, mime, len(data),
                        item["sha256"], str(local_path), dumps(checks)))
        return item

    def artifacts(self, run_id: str) -> list[dict]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM artifacts WHERE run_id=?", (run_id,)).fetchall()
        return [{**dict(row), "checks": json.loads(row["checks_json"])} for row in rows]

    def get_artifact(self, run_id: str, artifact_id: str) -> dict:
        for artifact in self.artifacts(run_id):
            if artifact["artifact_id"] == artifact_id:
                return artifact
        raise KeyError(artifact_id)

    def add_verdict(self, run_id: str, dimension: str, evaluator: str, result: str,
                    rationale: str, evidence: list[str], critical: bool = False,
                    reviewer: str | None = None) -> None:
        with self.connect() as db:
            db.execute("INSERT INTO verdicts VALUES(?,?,?,?,?,?,?,?,?,?)",
                       (f"verdict_{uuid4().hex}", run_id, dimension, evaluator, result,
                        int(critical), rationale, dumps(evidence), reviewer, now()))

    def verdicts(self, run_id: str) -> list[dict]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM verdicts WHERE run_id=? ORDER BY created_at", (run_id,)).fetchall()
        return [{**dict(r), "evidence": json.loads(r["evidence_json"])} for r in rows]
