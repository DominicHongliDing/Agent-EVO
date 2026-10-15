from __future__ import annotations

import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path
from uuid import uuid4
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from agent_evo.langfuse_sync import Connection, quality, snapshot, queue_export
from agent_evo.models import DatasetInput
from agent_evo.script_runtime import inspect_interpreter
from agent_evo.script_store import binding, default_interpreter, get_script, import_script, update_binding, verify_script
from agent_evo.store import now


class ScriptBatch(BaseModel):
    repetitions: int = Field(default=1, ge=1, le=5)
    script_id: str = ''
    dataset_id: str
    case_ids: list[str] = Field(min_length=1, max_length=100)
    label: str = Field(min_length=1, max_length=120)
    interpreter: str = Field(max_length=1000)
    working_directory: str = Field(default='', max_length=1000)
    timeout_seconds: int = Field(default=600, ge=10, le=3600)
    sync_enabled: bool = False
    trusted_script: bool = False
    reviewed_deidentified: bool = False


class ConnectInput(BaseModel):
    host: str = Field(max_length=500)
    public_key: str = Field(max_length=300)
    secret_key: str = Field(max_length=300)
    project_id: str = Field(max_length=200)


class ExportInput(BaseModel):
    run_ids: list[str] = Field(min_length=1, max_length=100)
    reviewed_deidentified: bool = False


def local_request(request):
    host = request.url.hostname
    if host not in {'127.0.0.1', 'localhost', '::1'}:
        raise HTTPException(403, '本地执行接口只接受回环 Host')
    origin = request.headers.get('origin')
    if origin and origin.rstrip('/') != str(request.base_url).rstrip('/'):
        raise HTTPException(403, '禁止跨站调用本地执行接口')
    if request.headers.get('sec-fetch-site') == 'cross-site':
        raise HTTPException(403, '禁止跨站调用本地执行接口')


def install_script_api(app, store, sync):
    token = secrets.token_urlsafe(32)

    def guard(request: Request):
        if os.getenv('EVO_LOCAL_SCRIPTS_ENABLED', '1').lower() in {'0', 'false'}:
            raise HTTPException(503, '本地脚本功能已关闭；已有证据和待传状态保留')
        local_request(request)
        if not hmac.compare_digest(request.headers.get('X-EVO-Local-Token', ''), token):
            raise HTTPException(401, '本地会话已失效，请刷新页面')

    @app.get('/api/local-evaluations/bootstrap')
    def bootstrap(request: Request):
        local_request(request)
        if request.headers.get('X-EVO-Bootstrap') != '1':
            raise HTTPException(403, '需要本地页面发起连接')
        if store.settings.access_token and not hmac.compare_digest(request.headers.get('X-EVO-Token', ''), store.settings.access_token):
            raise HTTPException(401, '请填写本地平台访问令牌')
        return {'mode': 'local', 'token': token, 'interpreter': default_interpreter(), 'agent': 'Clinical Agent'}

    @app.middleware('http')
    async def script_security(request, call_next):
        # Covers legacy retry routes too; a cross-site form must not start scripts.
        if request.url.path.startswith('/api/'):
            try:
                if request.url.path == '/api/local-evaluations/scripts' and int(request.headers.get('content-length', '0')) > 5 * 1024 * 1024 + 65536:
                    raise HTTPException(413, '脚本上传不得超过 5 MiB')
                if request.headers.get('origin') or request.headers.get('sec-fetch-site') == 'cross-site':
                    local_request(request)
                if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
                    matched = re.match(r'^/api/runs/([^/]+)/', request.url.path)
                    batch = re.match(r'^/api/batches/([^/]+)/retry-selected$', request.url.path)
                    requires_token = matched and binding(store, matched[1])
                    if batch:
                        with store.connect() as db:
                            requires_token = db.execute('SELECT 1 FROM script_runs s JOIN runs r USING(run_id) WHERE r.batch_id=? LIMIT 1', (batch[1],)).fetchone()
                    if requires_token:
                        guard(request)
            except HTTPException as exc:
                from fastapi.responses import JSONResponse
                return JSONResponse({'detail': exc.detail}, status_code=exc.status_code)
        response = await call_next(request)
        if request.url.path.startswith('/api/local-evaluations'):
            response.headers['Cache-Control'] = 'no-store'
            response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    router = APIRouter(prefix='/api/local-evaluations', dependencies=[Depends(guard)])

    def operation(fn):
        try:
            return fn()
        except KeyError:
            raise HTTPException(404, '记录不存在') from None
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None

    @router.get('/status')
    def status():
        with store.connect() as db:
            states = {r['state']: r['n'] for r in db.execute('SELECT state,COUNT(*) n FROM sync_outbox GROUP BY state')}
        connection = sync.connection
        return {'connected': bool(connection), 'host': connection.host if connection else None,
            'project_id': connection.project_id if connection else None, 'sync_states': states,
            'credential_lifetime': 'process', 'worker': store.worker_status()}

    @router.post('/connection')
    def connect(payload: ConnectInput):
        try:
            connection = Connection(**payload.model_dump())
            connection.check()
        except (ValueError, httpx.HTTPError, KeyError):
            raise HTTPException(422, '连接失败：请核对区域地址、项目 ID 和项目级凭证') from None
        sync.connection = connection
        return {'connected': True, 'project_id': connection.project_id}

    @router.get('/scripts')
    def scripts():
        with store.connect() as db:
            ids = [r[0] for r in db.execute('SELECT script_id FROM eval_scripts WHERE archived_at IS NULL ORDER BY created_at DESC')]
        return {'items': [get_script(store, i) for i in ids]}

    @router.post('/scripts', status_code=201)
    async def upload(file: UploadFile = File(...)):
        content = await file.read(5 * 1024 * 1024 + 1)
        return operation(lambda: import_script(store, file.filename or '', content))

    @router.post('/scripts/{script_id}/archive')
    def archive(script_id: str):
        operation(lambda: get_script(store, script_id))
        with store.connect() as db:
            db.execute('UPDATE eval_scripts SET archived_at=? WHERE script_id=?', (now(), script_id))
        return {'archived': True, 'referenced_versions_preserved': True}

    @router.get('/template')
    def template():
        from fastapi.responses import FileResponse
        return FileResponse(Path(__file__).resolve().parents[2] / 'examples/evaluations/clinical.py', filename='clinical.py', media_type='text/x-python')

    @router.get('/datasets')
    def datasets():
        return {'items': [d for d in store.list_datasets() if d['profile'] == 'clinical']}

    @router.post('/datasets', status_code=201)
    def upload_dataset(payload: DatasetInput):
        if payload.profile != 'clinical':
            raise HTTPException(422, '请选择 Clinical 格式测试集')
        return operation(lambda: store.import_dataset(payload))

    @router.get('/cases')
    def cases(dataset_id: str):
        return {'items': store.list_cases('clinical', dataset_id)}

    @router.post('/batches', status_code=201)
    def create_batch(payload: ScriptBatch):
        def create():
            if payload.script_id and not payload.trusted_script:
                raise ValueError('请先确认该脚本可信；它以当前用户权限在本机运行')
            if payload.sync_enabled and not payload.reviewed_deidentified:
                raise ValueError('同步前请确认测试数据已合成或脱敏')
            execution = None
            if payload.script_id:
                script = get_script(store, payload.script_id)
                if script['archived_at']:
                    raise ValueError('此版本已归档，请重新选择')
                verify_script(store, script)
                interpreter, environment = inspect_interpreter(payload.interpreter, script['manifest'].get('requirements', []))
                directory = Path(payload.working_directory or script['default_working_directory']).resolve()
                if not directory.is_dir():
                    raise ValueError('工作目录不存在，请选择本机现有目录')
                execution = {**payload.model_dump(), 'interpreter': interpreter, 'working_directory': str(directory)}
            try:
                response = httpx.get(store.settings.clinical_url + '/health', timeout=3, trust_env=False)
                response.raise_for_status()
            except httpx.HTTPError:
                raise ValueError('Clinical 服务当前不可用，请先启动本地业务后端和数据库，再开始真实评测') from None
            for cid in payload.case_ids:
                case = store.get_case(cid)
                if case['agent'] != 'clinical' or not case['synthetic']:
                    raise ValueError('只允许合成或脱敏 Clinical 用例')
            # Registry assignment is explicit here and retains previous selections.
            with store.connect() as db:
                db.execute('INSERT OR IGNORE INTO agent_datasets(agent_id,dataset_id) VALUES(?,?)', ('agent_clinical', payload.dataset_id))
            result = store.create_managed_batch(payload.case_ids, payload.label, 'agent_clinical', payload.dataset_id, script=execution, repetitions=payload.repetitions)
            if not execution and payload.sync_enabled:
                with store.connect() as db:
                    for run in result['runs']:
                        db.execute('INSERT INTO sync_exports(run_id,enabled,updated_at) VALUES(?,1,?)', (run['run_id'], now()))
            return result
        return operation(create)

    def detail(run_id):
        run = store.get_run(run_id)
        if store.get_case(run['case_id'])['agent'] != 'clinical':
            raise KeyError(run_id)
        record = snapshot(store, run_id)
        with store.connect() as db:
            row = db.execute("SELECT o.state,o.last_error,o.acknowledged_at,o.created_at,e.enabled FROM sync_outbox o JOIN sync_exports e USING(run_id) WHERE o.run_id=? AND o.kind='record' ORDER BY o.created_at DESC LIMIT 1", (run_id,)).fetchone()
        record['sync'] = dict(row) if row else {'state': 'not_selected'}
        record['quality'] = quality(record)
        if record.get('script'):
            record['script_logs'] = []
            for log_path in sorted((store.settings.artifact_root / run_id).glob('script-*.log'), key=lambda p: p.stat().st_mtime)[-3:]:
                if log_path.is_symlink():
                    continue
                from agent_evo.langfuse_sync import redact
                with log_path.open('rb') as log:
                    log.seek(max(0, log_path.stat().st_size - 32000))
                    record['script_logs'].append({'filename': log_path.name, 'tail': redact(log.read().decode('utf-8', errors='replace')), 'local_only': True})
        if sync.connection:
            record['langfuse_url'] = sync.connection.host + '/project/' + sync.connection.project_id + '/traces/' + run['trace_id']
        return record

    @router.get('/runs')
    def runs():
        # List views must not repeatedly decode/redact every complete trace.
        with store.connect() as db:
            rows = db.execute("""SELECT r.run_id,r.batch_id,b.label batch_label,r.status,r.model_calls,r.started_at,r.finished_at,
                c.data_json case_json,s.script_id,s.process_status,s.evaluator_status,o.state sync_state,o.last_error
                FROM runs r JOIN cases c USING(case_id) JOIN batches b USING(batch_id)
                LEFT JOIN script_runs s USING(run_id)
                LEFT JOIN sync_outbox o ON o.item_id=(SELECT item_id FROM sync_outbox WHERE run_id=r.run_id AND kind='record' ORDER BY created_at DESC LIMIT 1)
                WHERE c.agent='clinical' AND b.deleted_at IS NULL ORDER BY r.rowid DESC LIMIT 500""").fetchall()
            verdicts = db.execute("SELECT run_id,dimension,evaluator,result,critical,rationale FROM verdicts ORDER BY created_at").fetchall()
        by_run = {}
        for verdict in verdicts:
            by_run.setdefault(verdict['run_id'], []).append(dict(verdict))
        from agent_evo.langfuse_sync import redact
        items = []
        for row in rows:
            item = dict(row)
            item['case'] = redact(json.loads(item.pop('case_json')))
            script_id = item.pop('script_id')
            process_status, evaluator_status = item.pop('process_status'), item.pop('evaluator_status')
            item['script'] = {'script_id': script_id, 'process_status': process_status, 'evaluator_status': evaluator_status} if script_id else None
            item['sync'] = {'state': item.pop('sync_state') or 'not_selected', 'last_error': item.pop('last_error')}
            item['quality'] = quality({**item, 'verdicts': by_run.get(item['run_id'], [])})
            item['batch_label'] = redact(item['batch_label'])
            items.append(item)
        return {'items': items}

    @router.get('/runs/{run_id}')
    def run_detail(run_id: str):
        return operation(lambda: detail(run_id))

    @router.post('/runs/{run_id}/cancel')
    def cancel(run_id: str):
        operation(lambda: store.get_run(run_id))
        if not binding(store, run_id):
            raise HTTPException(422, '此记录不属于脚本执行')
        update_binding(store, run_id, cancel_requested=1)
        if store.cancel_queued(run_id):
            update_binding(store, run_id, process_status='cancelled', evaluator_status='not_started')
        return {'cancel_requested': True, 'backend_result_may_be_unknown': True}

    @router.post('/runs/{run_id}/retry')
    def retry(run_id: str):
        operation(lambda: snapshot(store, run_id))
        return operation(lambda: store.retry(run_id))

    @router.post('/batches/{batch_id}/cancel')
    def cancel_batch(batch_id: str):
        batch = operation(lambda: store.get_batch(batch_id))
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('UPDATE script_runs SET cancel_requested=1 WHERE run_id IN (SELECT run_id FROM runs WHERE batch_id=?)', (batch_id,))
            db.execute("UPDATE script_runs SET process_status='cancelled',evaluator_status='not_started' WHERE run_id IN (SELECT run_id FROM runs WHERE batch_id=? AND status='queued')", (batch_id,))
            db.execute("UPDATE runs SET status='cancelled',finished_at=? WHERE batch_id=? AND status='queued' AND run_id IN (SELECT run_id FROM script_runs)", (now(), batch_id))
        return {'cancel_requested': True}

    @router.post('/runs/{run_id}/rescore')
    def rescore(run_id: str):
        run = operation(lambda: store.get_run(run_id))
        contract = binding(store, run_id)
        if not contract or run['status'] in {'running', 'queued'}:
            raise HTTPException(422, '仅支持已结束的脚本记录重新评分')
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute("SELECT 1 FROM scoring_jobs WHERE run_id=? AND status IN ('queued','running')", (run_id,)).fetchone():
                raise HTTPException(409, '该记录正在等待评分或评分中')
            db.execute("INSERT INTO scoring_jobs VALUES(?,?,'queued',?,NULL)", ('scorejob_' + uuid4().hex, run_id, now()))
            db.execute("UPDATE script_runs SET cancel_requested=0,process_status='queued',evaluator_status='pending' WHERE run_id=?", (run_id,))
        return {'queued': True, 'new_business_calls': 0, 'judge_may_charge': True}

    @router.post('/runs/{run_id}/sync-retry')
    def retry_sync(run_id: str):
        with store.connect() as db:
            db.execute("UPDATE sync_outbox SET state=CASE WHEN acknowledged_at IS NULL THEN 'pending' ELSE 'indexing' END,next_attempt=0 WHERE run_id=? AND state IN ('needs_action','partial','indexing','pending') AND last_error IS NOT 'payload_exceeds_4_mib'", (run_id,))
        return {'new_business_calls': 0}

    @router.post('/runs/{run_id}/sync-stop')
    def stop_sync(run_id: str):
        with store.connect() as db:
            db.execute('UPDATE sync_exports SET enabled=0,updated_at=? WHERE run_id=?', (now(), run_id))
        return {'enabled': False, 'cloud_deleted': False, 'in_flight_request_may_finish': True}

    @router.post('/exports/preview')
    def preview(payload: ExportInput):
        return operation(lambda: {'items': [snapshot(store, r) for r in payload.run_ids]})

    @router.post('/exports')
    def exports(payload: ExportInput):
        if not payload.reviewed_deidentified:
            raise HTTPException(422, '请先预览并确认脱敏内容')
        records = operation(lambda: [snapshot(store, r) for r in payload.run_ids])
        if any(r['status'] not in {'completed', 'failed', 'blocked', 'timed_out', 'cancelled'} for r in records):
            raise HTTPException(422, '历史回填只接收已结束记录')
        with store.connect() as db:
            for record in records:
                db.execute('INSERT INTO sync_exports(run_id,enabled,updated_at) VALUES(?,1,?) ON CONFLICT(run_id) DO UPDATE SET enabled=1,dirty=1,updated_at=excluded.updated_at', (record['run_id'], now()))
        for record in records:
            queue_export(store, record['run_id'])
        return {'queued': len(records), 'new_business_calls': 0}

    app.include_router(router)
