"""Durable report jobs; credentials live only in process memory."""
from __future__ import annotations

import json
import os
import re
import threading
import time
from uuid import uuid4

import httpx
from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field

from agent_evo.reporting import MODEL, VERSION, REPORT_SYSTEM, ai_material, snapshot, validate_report
from agent_evo.store import dumps, now


class ReportOptions(BaseModel):
    regenerate: bool = False


class ReportConfig(BaseModel):
    model: str = Field(default=MODEL, pattern=r'^qwen[\w.:-]{0,95}$')
    api_key: str | None = Field(default=None, min_length=10, max_length=512)


def generate(material, key, model, progress=lambda status, result: None):
    usage, responses = [], []
    messages = [{'role': 'system', 'content': REPORT_SYSTEM},
                {'role': 'user', 'content': dumps(material)}]
    result = {'business_calls': 0, 'model': model, 'usage': usage, 'responses': responses, 'template_version': VERSION,
              'ai_coverage': material['coverage'], 'human_review_required': True, 'quota_verified': False}
    for attempt in range(2):
        progress('interpreting', result)
        started = time.monotonic()
        usage.append({'attempt': attempt + 1, 'request_id': None, 'usage': None, 'status': 'requesting'})
        progress('interpreting', result)
        try:
            response = httpx.post('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
                headers={'Authorization': 'Bearer ' + key}, json={
                    'model': model, 'temperature': 0, 'enable_thinking': False, 'max_tokens': 6500,
                    'response_format': {'type': 'json_object'}, 'messages': messages},
                timeout=120, trust_env=False, follow_redirects=False)
            body = response.json()
            usage[-1].update(request_id=body.get('id') or response.headers.get('x-request-id'),
                             usage=body.get('usage'), http_status=response.status_code,
                             latency_ms=round((time.monotonic() - started) * 1000), status='received')
            if response.status_code != 200:
                code = str((body.get('error') or {}).get('code', 'provider_error'))[:100]
                reason = '免费额度已用尽，已停止；保留基础报告。' if 'FreeTierOnly' in code else '百炼请求失败，请检查模型权限、额度及 Key。基础报告保留。'
                return {**result, 'status': 'failed', 'error_code': code, 'error': reason}
            progress('validating', result)
            try:
                content = body['choices'][0]['message']['content']
                from agent_evo.reporting import clean
                responses.append({'attempt': attempt + 1, 'content': clean(content.replace(key, '[凭证已移除]'))})
                report = validate_report(json.loads(content), material)
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                usage[-1]['status'] = 'validation_failed'
                usage[-1]['validation_error'] = str(exc)[:2400]
                messages += [
                    {'role': 'assistant', 'content': body.get('choices', [{}])[0].get('message', {}).get('content') or '{}'},
                    {'role': 'user', 'content': '请修复上次输出：' + str(exc)[:2400]
                     + '。重新输出全部五个数组；每条至少有有效指标键或证据，issues 和 recommendations 必须有 evidence。'
                     '引用只能从给定 evidence 中逐字选择，不增加不存在的 ref，不省略 Markdown 和标点。'
                     'text 不写阿拉伯数字，也不重复系统禁止的断言短语（包括否定句）。不得删掉无关的有效章节。'}]
                continue
            return {**result, 'status': 'completed', 'report': report}
        except (httpx.HTTPError, ValueError):
            usage[-1].update(status='request_failed', latency_ms=round((time.monotonic() - started) * 1000))
            return {**result, 'status': 'failed', 'error': '报告请求未取得有效响应，未自动重试。可检查网络后手动生成；基础报告保留。'}
    return {**result, 'status': 'failed', 'error': '两次输出均未通过章节或引用校验，未采纳 AI 报告；基础报告保留。'}


class ReportWorker:
    def __init__(self, store, answer_judge):
        self.store, self.judge = store, answer_judge
        self.model = os.getenv('EVO_REPORT_MODEL', MODEL)
        self.key = ''
        self.lock = threading.Lock()
        self.shutdown = threading.Event()
        self.thread = None
        with store.connect() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS evaluation_reports (
              report_id TEXT PRIMARY KEY, source TEXT NOT NULL, batch_id TEXT NOT NULL,
              snapshot_id TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              snapshot_json TEXT NOT NULL, result_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS report_jobs ON evaluation_reports(status,created_at);
            CREATE TABLE IF NOT EXISTS report_watches (
              source TEXT NOT NULL, batch_id TEXT NOT NULL, model TEXT NOT NULL,
              enabled INTEGER NOT NULL, PRIMARY KEY(source,batch_id)
            );
            ''')

    def credentials(self):
        with self.lock:
            return self.key or self.judge.key or os.getenv('DASHSCOPE_API_KEY', ''), self.model

    def status(self):
        key, model = self.credentials()
        return {'configured': bool(key), 'model': model, 'provider': '阿里云百炼', 'quota_verified': False}

    def enqueue(self, snap, model, regenerate=False):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            old = db.execute('SELECT * FROM evaluation_reports WHERE source=? AND batch_id=? AND snapshot_id=? AND model=? ORDER BY rowid DESC LIMIT 1',
                             (snap['source'], snap['batch_id'], snap['snapshot_id'], model)).fetchone()
            if old and (not regenerate or old['status'] in ('queued', 'interpreting', 'validating')):
                return old['report_id']
            identifier = 'report_' + uuid4().hex
            db.execute('INSERT INTO evaluation_reports VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (identifier, snap['source'], snap['batch_id'], snap['snapshot_id'], model, 'queued', now(), now(), dumps(snap), '{}'))
            return identifier

    def save_blocked(self, snap, model, reason, error_code):
        """Freeze the basic report when an upstream provider rejection stops work.

        This is a preflight outcome, with no report-model request or AI content.
        """
        result = {'status': 'failed', 'error_stage': 'preflight', 'error_code': error_code,
                  'error': reason, 'business_calls': 0, 'model_calls': 0, 'usage': [],
                  'responses': [], 'human_review_required': True, 'quota_verified': False}
        with self.store.connect() as db:
            old = db.execute('SELECT report_id FROM evaluation_reports WHERE source=? AND batch_id=? AND snapshot_id=? AND result_json=?',
                             (snap['source'], snap['batch_id'], snap['snapshot_id'], dumps(result))).fetchone()
            if old:
                return old['report_id']
            identifier = 'report_' + uuid4().hex
            db.execute('INSERT INTO evaluation_reports VALUES(?,?,?,?,?,?,?,?,?,?)',
                       (identifier, snap['source'], snap['batch_id'], snap['snapshot_id'], model,
                        'failed', now(), now(), dumps(snap), dumps(result)))
        return identifier

    def start(self):
        with self.store.connect() as db:
            db.execute("UPDATE evaluation_reports SET status='interrupted',updated_at=? WHERE status IN ('interpreting','validating')", (now(),))
        self.thread = threading.Thread(target=self.loop, daemon=True, name='report-worker')
        self.thread.start()

    def stop(self):
        self.shutdown.set()

    def loop(self):
        while not self.shutdown.is_set():
            try:
                self.check_watches()
                self.run_one()
            except Exception:
                # Do not expose network request headers or sensitive payloads in logs.
                pass
            self.shutdown.wait(2)

    def check_watches(self):
        key, _ = self.credentials()
        if not key:
            return
        with self.store.connect() as db:
            watches = [dict(r) for r in db.execute('SELECT * FROM report_watches WHERE enabled=1')]
        for w in watches:
            try:
                snap = snapshot(self.store, w['source'], w['batch_id'])
            except (KeyError, ValueError):
                continue
            if not snap['units'] or any(u['execution'] in ('queued', 'running') or u['assessment_status'] in ('not_started', 'queued', 'running') for u in snap['units']):
                continue
            self.enqueue(snap, w['model'])
            with self.store.connect() as db:
                db.execute('UPDATE report_watches SET enabled=0 WHERE source=? AND batch_id=?', (w['source'], w['batch_id']))

    def run_one(self):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            job = db.execute("SELECT * FROM evaluation_reports WHERE status='queued' ORDER BY rowid LIMIT 1").fetchone()
            if not job:
                return
            db.execute("UPDATE evaluation_reports SET status='interpreting',updated_at=? WHERE report_id=?", (now(), job['report_id']))
        def progress(status, result):
            with self.store.connect() as db:
                db.execute('UPDATE evaluation_reports SET status=?,result_json=?,updated_at=? WHERE report_id=?', (status, dumps(result), now(), job['report_id']))
        key, _ = self.credentials()
        try:
            result = generate(ai_material(json.loads(job['snapshot_json'])), key, job['model'], progress) if key else {'status': 'failed', 'error': '未配置百炼 Key，基础报告保留。', 'business_calls': 0}
        except Exception:
            result = {'status': 'failed', 'error': '报告处理失败，基础报告保留。', 'business_calls': 0}
        progress(result['status'], result)


def install(app, worker, access):
    async def guard(request: Request):
        await access(request)
        if request.method != 'GET':
            if request.headers.get('X-EVO-Reports') != '1':
                raise HTTPException(403, '请从报告入口操作')
            origin = request.headers.get('origin')
            if origin and origin != str(request.base_url).rstrip('/'):
                raise HTTPException(403, '跨站请求被拒绝')
    dependencies = [Depends(guard)]

    @app.post('/api/reports/visitor/report/generate', dependencies=dependencies)
    async def visitor(request: Request):
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 512 * 1024:
                raise HTTPException(413, '报告材料过大')
        key = request.headers.get('Authorization', '').removeprefix('Bearer ')
        try:
            body = json.loads(raw)
            material, model = body['material'], body['model']
            if not 10 <= len(key) <= 512 or not re.fullmatch(r'qwen[\w.:-]{0,95}', model):
                raise ValueError()
            if len(dumps(material)) > 85000 or not isinstance(material['metrics'], dict) or not isinstance(material['coverage'], dict) or not isinstance(material['records'], list) or len(material['records']) > 24:
                raise ValueError()
            for r in material['records']:
                if not isinstance(r['id'], str) or any(not isinstance(e['ref'], str) or not isinstance(e['text'], str) or len(e['text']) > 900 for e in r['evidence']):
                    raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise HTTPException(422, '报告材料或模型配置无效') from None
        from starlette.concurrency import run_in_threadpool
        from agent_evo.reporting import clean
        return await run_in_threadpool(generate, clean(material), key, model)

    @app.get('/api/reports/config', dependencies=dependencies)
    def config():
        return worker.status()

    @app.post('/api/reports/config', dependencies=dependencies)
    def configure(payload: ReportConfig):
        with worker.lock:
            worker.model = payload.model
            if payload.api_key:
                worker.key = payload.api_key.strip()
        return worker.status()

    @app.get('/api/reports/{source}/{batch_id}', dependencies=dependencies)
    def inspect(source: str, batch_id: str):
        try:
            snap = snapshot(worker.store, source, batch_id)
        except (KeyError, ValueError):
            raise HTTPException(404, '报告批次不存在') from None
        with worker.store.connect() as db:
            reports = [dict(r) for r in db.execute('SELECT report_id,snapshot_id,model,status,created_at,updated_at,result_json FROM evaluation_reports WHERE source=? AND batch_id=? ORDER BY rowid DESC', (source, batch_id))]
            watch = db.execute('SELECT enabled FROM report_watches WHERE source=? AND batch_id=?', (source, batch_id)).fetchone()
        return {'snapshot': snap, 'reports': [{**{k: v for k, v in r.items() if k != 'result_json'}, 'result': json.loads(r['result_json']), 'stale': r['snapshot_id'] != snap['snapshot_id']} for r in reports], 'watch': bool(watch and watch[0])}

    @app.get('/api/reports/saved/{report_id}/snapshot', dependencies=dependencies)
    def saved(report_id: str):
        with worker.store.connect() as db:
            row = db.execute('SELECT snapshot_json FROM evaluation_reports WHERE report_id=?', (report_id,)).fetchone()
        if not row:
            raise HTTPException(404, '报告不存在')
        return json.loads(row[0])

    @app.post('/api/reports/{source}/{batch_id}', dependencies=dependencies)
    def create(source: str, batch_id: str, payload: ReportOptions):
        key, model = worker.credentials()
        if not key:
            raise HTTPException(422, '请先配置百炼 Key')
        try:
            snap = snapshot(worker.store, source, batch_id)
        except (KeyError, ValueError):
            raise HTTPException(404, '报告批次不存在') from None
        if not snap['units']:
            raise HTTPException(422, '批次尚无记录')
        if any(u['execution'] in ('queued', 'running') or u['assessment_status'] in ('queued', 'running') for u in snap['units']):
            raise HTTPException(409, '请等待执行与评分结束；可勾选完成后生成')
        return {'report_id': worker.enqueue(snap, model, payload.regenerate)}

    @app.post('/api/reports/{source}/{batch_id}/watch', dependencies=dependencies)
    def watch(source: str, batch_id: str, enabled: bool):
        key, model = worker.credentials()
        if enabled and not key:
            raise HTTPException(422, '请先配置百炼 Key')
        try:
            snapshot(worker.store, source, batch_id)
        except (KeyError, ValueError):
            raise HTTPException(404, '报告批次不存在') from None
        with worker.store.connect() as db:
            db.execute('INSERT OR REPLACE INTO report_watches VALUES(?,?,?,?)', (source, batch_id, model, int(enabled)))
        return {'watch': enabled}
