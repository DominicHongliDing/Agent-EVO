"""Local, immutable script versions and per-run execution contracts."""
from __future__ import annotations

import ast
import hashlib
import io
import json
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath
from uuid import uuid4

from agent_evo.store import dumps, now


def migrate(store):
    with store.connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS eval_scripts (
          script_id TEXT PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE,
          manifest_json TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT);
        CREATE TABLE IF NOT EXISTS script_runs (
          run_id TEXT PRIMARY KEY REFERENCES runs(run_id), script_id TEXT NOT NULL REFERENCES eval_scripts(script_id),
          interpreter TEXT NOT NULL, timeout_seconds INTEGER NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0,
          evaluator_status TEXT NOT NULL DEFAULT 'pending', process_status TEXT NOT NULL DEFAULT 'queued');
        CREATE TABLE IF NOT EXISTS sync_exports (
          run_id TEXT PRIMARY KEY REFERENCES runs(run_id), enabled INTEGER NOT NULL DEFAULT 1,
          revision TEXT, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS scoring_jobs (
          job_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id),
          status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT);
        CREATE TABLE IF NOT EXISTS sync_outbox (
          item_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(run_id), revision TEXT NOT NULL,
          kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt REAL NOT NULL DEFAULT 0, last_error TEXT, acknowledged_at TEXT);
        CREATE INDEX IF NOT EXISTS idx_sync_ready ON sync_outbox(state,next_attempt);
        CREATE INDEX IF NOT EXISTS idx_sync_run ON sync_outbox(run_id,kind,created_at);
        """)
        existing = {r['name'] for r in db.execute('PRAGMA table_info(sync_exports)')}
        for name, definition in [('dirty', 'INTEGER NOT NULL DEFAULT 1'), ('destination', 'TEXT')]:
            if name not in existing:
                db.execute(f'ALTER TABLE sync_exports ADD COLUMN {name} {definition}')
        if 'working_directory' not in {r['name'] for r in db.execute('PRAGMA table_info(script_runs)')}:
            db.execute('ALTER TABLE script_runs ADD COLUMN working_directory TEXT')
        for table, change in [('runs', 'UPDATE'), ('events', 'INSERT'), ('verdicts', 'INSERT'), ('script_runs', 'UPDATE')]:
            db.execute(f'''CREATE TRIGGER IF NOT EXISTS sync_dirty_{table} AFTER {change} ON {table}
                BEGIN UPDATE sync_exports SET dirty=1 WHERE run_id=NEW.run_id; END''')


def root(store):
    return store.settings.db_path.parent / 'evaluation-scripts'


def safe_path(name):
    path = PurePosixPath(name)
    if not name or '\\' in name or ':' in name or path.is_absolute() or '..' in path.parts:
        raise ValueError('压缩包包含不安全路径')
    if any(p.endswith((' ', '.')) or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', p, re.I) for p in path.parts):
        raise ValueError('压缩包包含 Windows 保留文件名')
    forbidden = {'.env', '.git', '.venv', 'venv', 'node_modules', '__pycache__'}
    if any(p.lower() in forbidden or p.lower().startswith('.env.') for p in path.parts):
        raise ValueError('请移除凭证、环境目录和依赖目录')
    if path.suffix.lower() not in {'.py', '.json', '.txt', '.md'}:
        raise ValueError('脚本包仅接受 Python、JSON、TXT 和 Markdown 文件')
    return path


def import_script(store, filename: str, content: bytes):
    if len(content) > 5 * 1024 * 1024:
        raise ValueError('脚本文件超过 5 MiB')
    files = {}
    if filename.lower().endswith('.py'):
        files['evaluation.py'] = content
        files['manifest.json'] = dumps({'name': Path(filename).stem, 'entrypoint': 'evaluation.py', 'protocol': 1}).encode()
    elif filename.lower().endswith('.zip'):
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                entries = archive.infolist()
                if len(entries) > 100 or sum(i.file_size for i in entries) > 20 * 1024 * 1024:
                    raise ValueError('脚本包最多 100 个文件，解压总量不得超过 20 MiB')
                for info in entries:
                    if info.is_dir():
                        continue
                    path = str(safe_path(info.filename))
                    if stat.S_ISLNK(info.external_attr >> 16) or path.casefold() in {p.casefold() for p in files}:
                        raise ValueError('不接受软链接或重复文件名')
                    files[path] = archive.read(info)
        except (zipfile.BadZipFile, RuntimeError) as exc:
            raise ValueError('无法读取脚本 ZIP 文件') from exc
    else:
        raise ValueError('请选择 .py 或 .zip 文件')
    try:
        manifest = json.loads(files['manifest.json'].decode('utf-8-sig'))
        if not isinstance(manifest, dict) or set(manifest) - {'name', 'entrypoint', 'protocol', 'requirements'}:
            raise ValueError('manifest 包含不支持的字段；Agent 地址由平台固定管理')
        entry = str(safe_path(manifest['entrypoint']))
        if manifest.get('protocol') != 1 or not entry.endswith('.py') or entry not in files:
            raise ValueError('入口必须是包内 Python 文件，protocol 必须为 1')
        if not isinstance(manifest.get('name'), str) or not 1 <= len(manifest['name']) <= 80:
            raise ValueError('脚本名称应为 1–80 个字符')
        requirements = manifest.get('requirements', [])
        if not isinstance(requirements, list) or any(not isinstance(x, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', x) for x in requirements):
            raise ValueError('requirements 应为依赖包名列表，版本约束请固定在虚拟环境中')
        for name, data in files.items():
            source = data.decode('utf-8-sig')
            if '-----BEGIN ' in source and 'PRIVATE KEY-----' in source:
                raise ValueError('脚本包包含私钥，请移除后重试')
            if re.search(r'\b(?:sk|pk)-(?:lf-)?[A-Za-z0-9_-]{12,}', source):
                raise ValueError('脚本包包含疑似 API 凭证；请改为环境变量引用')
            if name.endswith('.py'):
                tree = ast.parse(source, filename=name)
                if name == entry and not any(isinstance(n, ast.FunctionDef) and n.name == 'run_case' for n in tree.body):
                    raise ValueError('入口需要定义同步函数 run_case(case, context)')
    except (KeyError, UnicodeError, SyntaxError, json.JSONDecodeError, TypeError) as exc:
        raise ValueError(f'脚本静态检查未通过：{type(exc).__name__}') from exc
    digest = hashlib.sha256(dumps({k: hashlib.sha256(v).hexdigest() for k, v in sorted(files.items())}).encode()).hexdigest()
    with store.connect() as db:
        existing = db.execute('SELECT script_id FROM eval_scripts WHERE sha256=?', (digest,)).fetchone()
    if existing:
        with store.connect() as db:
            db.execute('UPDATE eval_scripts SET archived_at=NULL WHERE script_id=?', (existing['script_id'],))
        return get_script(store, existing['script_id'])
    identifier = 'script_' + uuid4().hex
    directory = root(store) / identifier
    directory.mkdir(parents=True)
    for name, data in files.items():
        target = directory / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    with store.connect() as db:
        db.execute('INSERT INTO eval_scripts VALUES(?,?,?,?,?,NULL)', (identifier, manifest['name'], digest, dumps(manifest), now()))
    return get_script(store, identifier)


def get_script(store, identifier):
    with store.connect() as db:
        row = db.execute('SELECT * FROM eval_scripts WHERE script_id=?', (identifier,)).fetchone()
    if not row:
        raise KeyError(identifier)
    return {**dict(row), 'manifest': json.loads(row['manifest_json']), 'default_working_directory': str(root(store) / identifier)}


def verify_script(store, script):
    directory = root(store) / script['script_id']
    files = {}
    for path in directory.rglob('*'):
        if path.is_symlink():
            raise ValueError('脚本版本包含软链接')
        if path.is_file():
            files[path.relative_to(directory).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    if hashlib.sha256(dumps(dict(sorted(files.items()))).encode()).hexdigest() != script['sha256']:
        raise ValueError('脚本版本已被修改，请重新导入新版本')
    return directory


def binding(store, run_id):
    with store.connect() as db:
        row = db.execute('SELECT * FROM script_runs WHERE run_id=?', (run_id,)).fetchone()
    return dict(row) if row else None


def update_binding(store, run_id, **fields):
    if not fields or set(fields) - {'cancel_requested', 'process_status', 'evaluator_status'}:
        raise ValueError('invalid script state')
    with store.connect() as db:
        db.execute(f"UPDATE script_runs SET {','.join(k+'=?' for k in fields)} WHERE run_id=?", (*fields.values(), run_id))


def default_interpreter():
    return str(Path(sys.executable).resolve())
