from __future__ import annotations

import csv
import hashlib
import io
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from pydantic import ValidationError

from agent_evo.models import AgentInput, DatasetInput, EvalCase, case_payload


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def encode(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def profile(kind: str) -> str:
    return "generic" if kind == "http_json" else kind


def validate_target(data: dict) -> dict:
    result = AgentInput.model_validate(data).model_dump()
    parsed = urlparse(result["base_url"])
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError("业务地址端口无效") from exc
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"} or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("业务地址须为无凭证、无查询参数的本地 HTTP 回环地址")
    result["name"] = result["name"].strip()
    if not result["name"]:
        raise ValueError("Agent 名称不能为空")
    result["base_url"] = result["base_url"].rstrip("/")
    return result


def migrate_registry(store) -> None:
    with store.connect() as db:
        db.executescript("""
          CREATE TABLE IF NOT EXISTS agents (
            agent_id TEXT PRIMARY KEY, name TEXT NOT NULL, adapter_kind TEXT NOT NULL,
            base_url TEXT NOT NULL, endpoint_path TEXT NOT NULL, credential_env_prefix TEXT NOT NULL,
            created_at TEXT NOT NULL, deleted_at TEXT
          );
          CREATE TABLE IF NOT EXISTS datasets (
            dataset_id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
            profile TEXT NOT NULL, version TEXT NOT NULL, source_filename TEXT NOT NULL,
            content_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
          );
          CREATE TABLE IF NOT EXISTS agent_datasets (
            agent_id TEXT NOT NULL REFERENCES agents(agent_id), dataset_id TEXT NOT NULL REFERENCES datasets(dataset_id),
            PRIMARY KEY(agent_id,dataset_id)
          );
        """)
        additions = {"cases": {"dataset_id": "TEXT"}, "batches": {"pinned": "INTEGER NOT NULL DEFAULT 0", "deleted_at": "TEXT"},
                     "runs": {"agent_id": "TEXT", "dataset_id": "TEXT", "agent_snapshot_json": "TEXT NOT NULL DEFAULT '{}'", "execution_mode": "TEXT NOT NULL DEFAULT 'live'"}}
        for table, columns in additions.items():
            existing = {row["name"] for row in db.execute(f"PRAGMA table_info({table})")}
            for name, declaration in columns.items():
                if name not in existing:
                    db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
        for kind, url in (("unihr", store.settings.unihr_url), ("clinical", store.settings.clinical_url)):
            db.execute("INSERT OR IGNORE INTO agents VALUES(?,?,?,?,?,?,?,NULL)",
                       (f"agent_{kind}", "UniHR Agent" if kind == "unihr" else "Clinical Agent", kind, url, "/evaluate", f"EVO_{kind.upper()}", timestamp()))
        groups = db.execute("SELECT agent,suite_version FROM cases WHERE dataset_id IS NULL GROUP BY agent,suite_version").fetchall()
        for group in groups:
            kind, version = group["agent"], group["suite_version"]
            identifier = f"dataset_{kind}_{hashlib.sha256(version.encode()).hexdigest()[:8]}"
            rows = db.execute("SELECT case_id,content_sha256 FROM cases WHERE agent=? AND suite_version=? AND dataset_id IS NULL ORDER BY case_id", (kind, version)).fetchall()
            digest = hashlib.sha256(encode([dict(row) for row in rows]).encode()).hexdigest()
            db.execute("INSERT OR IGNORE INTO datasets VALUES(?,?,?,?,?,?,?,?,NULL)",
                       (identifier, f"{'UniHR' if kind == 'unihr' else 'Clinical'} 合成工程集", "预置合成工程草案，业务/医生金标待审核", kind, version, f"{kind}-50-{version}.jsonl", digest, timestamp()))
            db.execute("UPDATE cases SET dataset_id=? WHERE agent=? AND suite_version=? AND dataset_id IS NULL", (identifier, kind, version))
            db.execute("INSERT OR IGNORE INTO agent_datasets VALUES(?,?)", (f"agent_{kind}", identifier))
        rows = db.execute("SELECT r.run_id,c.agent,c.dataset_id FROM runs r JOIN cases c USING(case_id) WHERE r.agent_id IS NULL").fetchall()
        for row in rows:
            agent = dict(db.execute("SELECT * FROM agents WHERE agent_id=?", (f"agent_{row['agent']}",)).fetchone())
            dataset = dict(db.execute("SELECT * FROM datasets WHERE dataset_id=?", (row["dataset_id"],)).fetchone())
            agent.update(dataset_name=dataset["name"], dataset_version=dataset["version"], dataset_sha256=dataset["content_sha256"])
            db.execute("UPDATE runs SET agent_id=?,dataset_id=?,agent_snapshot_json=? WHERE run_id=?",
                       (agent["agent_id"], row["dataset_id"], encode(agent), row["run_id"]))


def preview_dataset(payload: DatasetInput, fixture_root: Path) -> dict:
    errors, validated, source_ids = [], [], set()
    if not payload.name.strip():
        errors.append({"line": 0, "message": "测试集名称不能为空"})
    if len(payload.content.encode("utf-8")) > 5_242_880:
        return {"valid": False, "total": 0, "errors": [{"line": 0, "message": "文件超过 5 MiB"}], "preview": [], "cases": []}
    suffix = Path(payload.filename).suffix.lower()
    try:
        content = payload.content.lstrip("\ufeff")
        if suffix == ".jsonl":
            raw_rows = []
            for n, line in enumerate(content.splitlines(), 1):
                if not line.strip():
                    continue
                try:
                    raw_rows.append((n, json.loads(line)))
                except json.JSONDecodeError:
                    raw_rows.append((n, None))
                    errors.append({"line": n, "message": "JSON 语法错误"})
        elif suffix == ".json":
            data = json.loads(content)
            data = data.get("cases") if isinstance(data, dict) else data
            if not isinstance(data, list):
                raise ValueError("JSON 须为用例数组或包含 cases 数组")
            raw_rows = list(enumerate(data, 1))
        elif suffix == ".csv":
            raw_rows = list(enumerate(csv.DictReader(io.StringIO(content)), 2))
        else:
            raise ValueError("只支持 .json、.jsonl、.csv")
    except (ValueError, csv.Error):
        return {"valid": False, "total": 0, "errors": [{"line": 0, "message": "文件格式错误，请核对 UTF-8 及模板结构"}], "preview": [], "cases": []}
    if not 1 <= len(raw_rows) <= 1000:
        errors.append({"line": 0, "message": "测试集须包含 1–1,000 条用例"})
    for line, raw in raw_rows[:1000]:
        if raw is None and any(error["line"] == line for error in errors):
            continue
        try:
            if not isinstance(raw, dict):
                raise ValueError("用例须为对象")
            if any(re.search(r"password|token|api.?key|secret|credential", str(key), re.I) for key in raw):
                raise ValueError("禁止上传凭证字段")
            serialized = encode(raw)
            if re.search(r'"(?:password|access_token|api_key|secret)"\s*:', serialized, re.I):
                raise ValueError("禁止上传凭证字段")
            if re.search(r"(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\d)|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\bsk-[A-Za-z0-9]{16,}", serialized):
                raise ValueError("发现可能的个人标识或凭证，请先脱敏")
            source_id = str(raw.get("case_id") or f"row_{line}")
            if source_id in source_ids:
                raise ValueError("本文件存在重复 case_id")
            source_ids.add(source_id)
            if raw.get("agent") not in {None, "", payload.profile}:
                raise ValueError("用例与所选评测合同不兼容")
            if raw.get("gold_status", "engineering_draft") != "engineering_draft":
                raise ValueError("上传用例只能标记工程草案，审批需人工复核")
            values = {key: value for key, value in raw.items() if value not in (None, "")}
            for key in ("expected", "fixtures", "turns"):
                if isinstance(values.get(key), str):
                    values[key] = json.loads(values[key])
            if "synthetic" in values and values["synthetic"] not in {True, "true", "True", "1"}:
                raise ValueError("只允许合成或脱敏工程用例")
            turns = values.get("turns") or []
            first_message = turns[0].get("message", "") if isinstance(turns, list) and turns and isinstance(turns[0], dict) else ""
            values.update(case_id=f"case_{uuid4().hex}", agent=payload.profile, suite_version=payload.version, synthetic=True,
                          title=str(raw.get("title") or source_id), category=str(raw.get("category") or "general"),
                          message=raw.get("message") or raw.get("input") or first_message)
            case = case_payload(EvalCase.model_validate(values))
            prompts = [case["message"], case.get("case_context_text") or ""] + [turn["message"] for turn in case.get("turns", [])]
            if any(re.search(r"虚构|合成(?:测试|病例|简历|数据)|用于(?:系统)?测试|仅供测试|教学病例|测试输入", prompt) for prompt in prompts):
                raise ValueError("输入请使用自然求助问法；数据来源属性放在元信息，不写入提问")
            if payload.profile == "generic" and case["fixtures"]:
                raise ValueError("通用 HTTP 协议当前不支持附件，请使用专用接入协议")
            for relative in case["fixtures"]:
                path = (fixture_root / relative).resolve()
                if fixture_root.resolve() not in path.parents or not path.is_file():
                    raise ValueError("附件必须引用受控 fixture 中的现有文件")
            case["source_case_id"] = source_id
            validated.append(case)
        except ValidationError:
            errors.append({"line": line, "message": "字段不符合合同：请核对输入、风险、预期和附件格式"})
        except json.JSONDecodeError:
            errors.append({"line": line, "message": "expected/fixtures JSON 格式错误"})
        except ValueError as exc:
            errors.append({"line": line, "message": str(exc)})
        except TypeError:
            errors.append({"line": line, "message": "字段类型不符合合同"})
    return {"valid": not errors, "total": len(raw_rows), "errors": errors[:100], "preview": validated, "cases": validated}


class Management:
    def list_agents(self, deleted=False) -> list[dict]:
        with self.connect() as db:
            rows = db.execute("SELECT * FROM agents WHERE (deleted_at IS NOT NULL)=? ORDER BY created_at", (int(deleted),)).fetchall()
            return [{**dict(row), "dataset_ids": [r[0] for r in db.execute("SELECT ad.dataset_id FROM agent_datasets ad JOIN datasets d USING(dataset_id) WHERE ad.agent_id=? AND d.deleted_at IS NULL", (row["agent_id"],))]} for row in rows]

    def get_agent(self, identifier: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT * FROM agents WHERE agent_id=?", (identifier,)).fetchone()
            if row is None:
                raise KeyError("Agent 不存在")
            return dict(row)

    def save_agent(self, data: dict, identifier: str | None = None) -> dict:
        value = validate_target(data)
        with self.connect() as db:
            if identifier:
                current = db.execute("SELECT * FROM agents WHERE agent_id=?", (identifier,)).fetchone()
                if not current or current["deleted_at"]:
                    raise KeyError("Agent 不存在或已删除")
                if value["adapter_kind"] != current["adapter_kind"]:
                    raise ValueError("已接入实例不能改变协议，请新建实例")
                db.execute("UPDATE agents SET name=?,base_url=?,endpoint_path=?,credential_env_prefix=? WHERE agent_id=?",
                           (value["name"], value["base_url"], value["endpoint_path"], value["credential_env_prefix"], identifier))
            else:
                identifier = f"agent_{uuid4().hex}"
                db.execute("INSERT INTO agents VALUES(?,?,?,?,?,?,?,NULL)", (identifier, value["name"], value["adapter_kind"], value["base_url"], value["endpoint_path"], value["credential_env_prefix"], timestamp()))
        return self.get_agent(identifier)

    def list_datasets(self, deleted=False) -> list[dict]:
        with self.connect() as db:
            return [dict(row) for row in db.execute("SELECT d.*,COUNT(c.case_id) case_count FROM datasets d LEFT JOIN cases c USING(dataset_id) WHERE (d.deleted_at IS NOT NULL)=? GROUP BY d.dataset_id ORDER BY d.created_at DESC", (int(deleted),))]

    def get_dataset(self, identifier: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT * FROM datasets WHERE dataset_id=?", (identifier,)).fetchone()
            if row is None:
                raise KeyError("测试集不存在")
            return dict(row)

    def import_dataset(self, payload: DatasetInput) -> dict:
        parsed = preview_dataset(payload, self.settings.fixture_root)
        if not parsed["valid"]:
            raise ValueError("测试集验证失败，请先修复预览中的逐行错误")
        identifier = f"dataset_{uuid4().hex}"
        digest = hashlib.sha256(encode([{k: v for k, v in case.items() if k != "case_id"} for case in parsed["cases"]]).encode()).hexdigest()
        with self.connect() as db:
            db.execute("INSERT INTO datasets VALUES(?,?,?,?,?,?,?,?,NULL)", (identifier, payload.name.strip(), payload.description, payload.profile, payload.version, Path(payload.filename).name, digest, timestamp()))
            for case in parsed["cases"]:
                digest_case = hashlib.sha256(encode(case).encode()).hexdigest()
                db.execute("INSERT INTO cases(case_id,agent,category,suite_version,risk_level,content_sha256,data_json,dataset_id) VALUES(?,?,?,?,?,?,?,?)",
                           (case["case_id"], case["agent"], case["category"], case["suite_version"], case["risk_level"], digest_case, encode(case), identifier))
        return next(item for item in self.list_datasets() if item["dataset_id"] == identifier)

    def rename_dataset(self, identifier: str, name: str) -> dict:
        if not name.strip():
            raise ValueError("名称不能为空")
        dataset = self.get_dataset(identifier)
        if dataset["deleted_at"]:
            raise ValueError("请先恢复测试集")
        with self.connect() as db:
            db.execute("UPDATE datasets SET name=? WHERE dataset_id=?", (name.strip(), identifier))
        return self.get_dataset(identifier)

    def assign_datasets(self, identifier: str, dataset_ids: list[str]) -> dict:
        if len(set(dataset_ids)) != len(dataset_ids):
            raise ValueError("测试集选择重复")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            agent = db.execute("SELECT * FROM agents WHERE agent_id=?", (identifier,)).fetchone()
            if not agent or agent["deleted_at"]:
                raise KeyError("Agent 不存在或已删除")
            for dataset_id in dataset_ids:
                dataset = db.execute("SELECT * FROM datasets WHERE dataset_id=?", (dataset_id,)).fetchone()
                if not dataset or dataset["deleted_at"] or dataset["profile"] != profile(agent["adapter_kind"]):
                    raise ValueError("所选测试集不存在、已删除或合同不兼容")
            db.execute("DELETE FROM agent_datasets WHERE agent_id=?", (identifier,))
            db.executemany("INSERT INTO agent_datasets VALUES(?,?)", [(identifier, ds) for ds in dataset_ids])
        return {"agent_id": identifier, "dataset_ids": dataset_ids}

    def change_entity_state(self, entity: str, identifier: str, restore=False) -> None:
        table, column = ("agents", "agent_id") if entity == "agent" else ("datasets", "dataset_id")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if not db.execute(f"SELECT 1 FROM {table} WHERE {column}=?", (identifier,)).fetchone():
                raise KeyError("对象不存在")
            if not restore and db.execute(f"SELECT 1 FROM runs WHERE {column}=? AND status IN ('queued','running') LIMIT 1", (identifier,)).fetchone():
                raise ValueError("对象被排队或运行中的任务引用，结束后才可删除")
            db.execute(f"UPDATE {table} SET deleted_at=? WHERE {column}=?", (None if restore else timestamp(), identifier))

    def manage_batches(self, identifiers: list[str], action: str) -> None:
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("批次选择重复")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            for identifier in identifiers:
                row = db.execute("SELECT * FROM batches WHERE batch_id=?", (identifier,)).fetchone()
                if not row:
                    raise KeyError("批次不存在")
                if action == "delete" and db.execute("SELECT 1 FROM runs WHERE batch_id=? AND status IN ('queued','running') LIMIT 1", (identifier,)).fetchone():
                    raise ValueError(f"批次“{row['label']}”有排队或运行任务，所选批次均未删除")
            for identifier in identifiers:
                if action in {"pin", "unpin"}:
                    db.execute("UPDATE batches SET pinned=? WHERE batch_id=?", (int(action == "pin"), identifier))
                else:
                    db.execute("UPDATE batches SET deleted_at=? WHERE batch_id=?", (None if action == "restore" else timestamp(), identifier))

    def create_managed_batch(self, case_ids: list[str], label: str, agent_id=None, dataset_id=None, *, script=None, repetitions=1) -> dict:
        if type(repetitions) is not int or not 1 <= repetitions <= 5:
            raise ValueError('每题独立运行次数须为 1–5')
        if not case_ids or len(case_ids) > 100 or len(set(case_ids)) != len(case_ids):
            raise ValueError("须选择 1–100 条唯一用例")
        if bool(agent_id) != bool(dataset_id):
            raise ValueError("须同时选择 Agent 和测试集")
        identifier = f"batch_{uuid4().hex}"
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            targets = []
            for case_id in case_ids:
                case = db.execute("SELECT * FROM cases WHERE case_id=?", (case_id,)).fetchone()
                if not case:
                    raise KeyError("用例不存在")
                from agent_evo.recordings import assert_replayable
                assert_replayable(json.loads(case["data_json"]))
                target_id = agent_id or f"agent_{case['agent']}"
                target_dataset = dataset_id or case["dataset_id"]
                agent = db.execute("SELECT * FROM agents WHERE agent_id=?", (target_id,)).fetchone()
                dataset = db.execute("SELECT * FROM datasets WHERE dataset_id=?", (target_dataset,)).fetchone()
                if not agent or not dataset or agent["deleted_at"] or dataset["deleted_at"]:
                    raise ValueError("执行目标或测试集不可用，请重新选择")
                if case["dataset_id"] != target_dataset or profile(agent["adapter_kind"]) != dataset["profile"]:
                    raise ValueError("用例、测试集和 Agent 合同不兼容")
                if agent_id and not db.execute("SELECT 1 FROM agent_datasets WHERE agent_id=? AND dataset_id=?", (target_id, target_dataset)).fetchone():
                    raise ValueError("请先给 Agent 分配该测试集")
                snapshot = dict(agent)
                snapshot.update(dataset_name=dataset["name"], dataset_version=dataset["version"], dataset_sha256=dataset["content_sha256"])
                targets.append((case, snapshot, target_dataset))
            db.execute("INSERT INTO batches(batch_id,label,created_at,repetitions) VALUES(?,?,?,?)", (identifier, label.strip() or "未命名评测", timestamp(), repetitions))
            for case, snapshot, ds, repetition in [(c, s, d, n) for c, s, d in targets for n in range(1, repetitions + 1)]:
                run_id = f"run_{uuid4().hex}"
                db.execute("INSERT INTO runs(run_id,batch_id,case_id,trace_id,status,case_sha256,agent_id,dataset_id,agent_snapshot_json,repetition_index) VALUES(?,?,?,?,?,?,?,?,?,?)",
                           (run_id, identifier, case["case_id"], uuid4().hex, "queued", case["content_sha256"], snapshot["agent_id"], ds, encode(snapshot), repetition))
                if script:
                    if snapshot['agent_id'] != 'agent_clinical':
                        raise ValueError('脚本评测第一版仅接入 Clinical')
                    db.execute('INSERT INTO script_runs(run_id,script_id,interpreter,timeout_seconds,working_directory) VALUES(?,?,?,?,?)',
                               (run_id, script['script_id'], script['interpreter'], script['timeout_seconds'], script.get('working_directory')))
                    db.execute('INSERT INTO sync_exports(run_id,enabled,updated_at) VALUES(?,?,?)', (run_id, int(script['sync_enabled']), timestamp()))
        return self.get_batch(identifier)

    def retry_selected(self, batch_id: str, run_ids: list[str]) -> dict:
        if not run_ids or len(run_ids) > 100 or len(set(run_ids)) != len(run_ids):
            raise ValueError("须选择 1–100 条唯一记录")
        old = self.get_batch(batch_id)
        identifier = f"batch_{uuid4().hex}"
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT deleted_at FROM batches WHERE batch_id=?", (batch_id,)).fetchone()[0]:
                raise ValueError("请先恢复原批次")
            rows = []
            for run_id in run_ids:
                run = db.execute("SELECT * FROM runs WHERE run_id=? AND batch_id=?", (run_id, batch_id)).fetchone()
                if not run or run["status"] in {"running", "queued"}:
                    raise ValueError("所选记录不属于该批次或尚未结束")
                from agent_evo.recordings import assert_replayable
                case_data = db.execute("SELECT data_json FROM cases WHERE case_id=?", (run["case_id"],)).fetchone()[0]
                assert_replayable(json.loads(case_data))
                for table, column in (("agents", "agent_id"), ("datasets", "dataset_id")):
                    entity = db.execute(f"SELECT deleted_at FROM {table} WHERE {column}=?", (run[column],)).fetchone()
                    if not entity or entity[0]:
                        raise ValueError("请先恢复原 Agent 与测试集")
                rows.append(run)
            db.execute("INSERT INTO batches(batch_id,label,created_at) VALUES(?,?,?)", (identifier, ("重跑 · " + old["label"])[:120], timestamp()))
            for row in rows:
                replacement = f"run_{uuid4().hex}"
                db.execute("INSERT INTO runs(run_id,batch_id,case_id,trace_id,status,case_sha256,retry_of,agent_id,dataset_id,agent_snapshot_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
                           (replacement, identifier, row["case_id"], uuid4().hex, "queued", row["case_sha256"], row["run_id"], row["agent_id"], row["dataset_id"], row["agent_snapshot_json"]))
                db.execute('INSERT INTO script_runs(run_id,script_id,interpreter,timeout_seconds,working_directory) SELECT ?,script_id,interpreter,timeout_seconds,working_directory FROM script_runs WHERE run_id=?', (replacement, row['run_id']))
                db.execute('INSERT INTO sync_exports(run_id,enabled,updated_at) SELECT ?,enabled,? FROM sync_exports WHERE run_id=?', (replacement, timestamp(), row['run_id']))
        return self.get_batch(identifier)

    def failures(self, batch_id: str, dimension: str | None = None, critical=False, query="") -> dict:
        batch = self.get_batch(batch_id)
        items = []
        for summary in batch["runs"]:
            run = self.get_run(summary["run_id"])
            case = self.get_case(run["case_id"])
            findings = [v for v in self.verdicts(run["run_id"]) if v["evaluator"] in {"deterministic-v1", "context-llm-v1"} and v["result"] == "fail"]
            if not findings and run["status"] not in {"failed", "timed_out", "blocked"}:
                continue
            matched = [v for v in findings if (not dimension or v["dimension"] == dimension or
                       (dimension == "context_all" and (v["dimension"] == "context" or v["dimension"].startswith("context_")))) and (not critical or v["critical"])]
            if (dimension or critical) and not matched:
                continue
            if query.lower() not in f"{case['title']} {case['message']} {case.get('source_case_id','')} {run['case_id']} {' '.join(v['rationale'] for v in findings)}".lower():
                continue
            items.append({**summary, "title": case["title"], "message": case["message"], "findings": matched,
                          "critical": any(v["critical"] for v in findings), "error_code": run["error_code"]})
        return {"items": items, "total": len(items), "assertion_count": sum(len(row["findings"]) for row in items)}
