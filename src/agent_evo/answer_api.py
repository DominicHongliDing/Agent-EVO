from __future__ import annotations

import json
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse
from pathlib import Path
from pydantic import BaseModel, Field

from agent_evo import answer_imports as imports
from agent_evo.models import DatasetInput
from agent_evo.store import dumps, now


class MappingInput(BaseModel):
    mapping: dict[str, str]
    dataset_id: str = ''
    confirm_order: bool = False


class CommitInput(MappingInput):
    name: str = Field(default='导入回答', max_length=120)
    reviewed_deidentified: bool = False


class JudgeConfig(BaseModel):
    api_key: str = Field(min_length=10, max_length=512)
    model: str = Field(default='qwen3.6-flash', pattern=r'^[A-Za-z0-9_.:/-]{1,100}$')


class Selection(BaseModel):
    record_ids: list[str] | None = Field(default=None, max_length=100)


class Regression(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    profile: Literal['clinical', 'generic'] = 'generic'
    dataset_id: str = ''
    expectations: dict[str, str]
    confirmed: bool = False


class Manage(BaseModel):
    action: Literal['pin', 'unpin', 'delete', 'restore', 'cancel']


def install(app, store, judge, access):
    async def guard(request: Request):
        await access(request)
        if request.method not in {'GET', 'HEAD'} and request.headers.get('X-EVO-Answers') != '1':
            raise HTTPException(403, '请从本地评测页面提交')
    router = APIRouter(prefix='/api/answers', dependencies=[Depends(guard)])

    def operation(fn):
        try:
            return fn()
        except KeyError as exc:
            raise HTTPException(404, str(exc).strip("'")) from None
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from None

    @router.get('/judge')
    def judge_status():
        return judge.status()

    @router.post('/judge')
    def configure(payload: JudgeConfig):
        return judge.configure(payload.api_key, payload.model)

    @router.post('/visitor-judge')
    async def visitor_judge(request: Request):
        # Browser-personal workspace also works when served by the local host.
        # Its supplied Key is isolated from the native queue configuration.
        from agent_evo.answer_judge import AnswerJudge
        import asyncio
        content = bytearray()
        async for chunk in request.stream():
            content.extend(chunk)
            if len(content) > 512 * 1024:
                raise HTTPException(413, '评分材料超过上限')
        try:
            payload = json.loads(content)
            record, model = payload['record'], payload['model']
            key = request.headers.get('Authorization', '').removeprefix('Bearer ')
            config = JudgeConfig(api_key=key, model=model)
            turns = record['turns']
            if not 1 <= len(turns) <= 40 or any(type(t['turn']) is not int or not 1 <= t['turn'] <= 40 or any(not isinstance(t[k], str) or len(t[k]) > 40000 for k in ('question', 'answer', 'reference')) for t in turns):
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise HTTPException(422, '请核对模型、Key 与完整问答字段') from None
        isolated = AnswerJudge(store)
        isolated.configure(config.api_key, config.model)
        status, result = await asyncio.to_thread(isolated.evaluate, record)
        return {'status': status, 'result': result}

    @router.post('/imports', status_code=201)
    async def upload(file: UploadFile = File(...)):
        content = await file.read(imports.LIMIT + 1)
        await file.close()
        return operation(lambda: imports.create_import(store, file.filename or 'answers.txt', content))

    @router.post('/imports/{identifier}/preview')
    def preview(identifier: str, payload: MappingInput):
        return operation(lambda: imports.normalize(store, identifier, payload.mapping, payload.dataset_id, payload.confirm_order))

    @router.get('/imports/{identifier}/file')
    def original_file(identifier: str):
        item = operation(lambda: imports.import_info(store, identifier))
        path = store.settings.artifact_root / 'answer-imports' / (item['import_id'] + Path(item['filename']).suffix.lower())
        if not path.is_file():
            raise HTTPException(404, '原文件不可用，解析后的字段仍保留')
        return FileResponse(path, filename=item['filename'], media_type='application/octet-stream')

    @router.post('/imports/{identifier}/commit', status_code=201)
    def commit(identifier: str, payload: CommitInput):
        return operation(lambda: imports.commit_import(store, identifier, payload))

    @router.get('/batches')
    def batches(deleted: bool = False):
        return {'items': imports.list_batches(store, deleted)}

    @router.get('/batches/{identifier}')
    def batch(identifier: str):
        matches = [b for b in imports.list_batches(store) + imports.list_batches(store, True) if b['batch_id'] == identifier]
        if not matches:
            raise HTTPException(404, '批次不存在')
        return matches[0]

    @router.post('/batches/{identifier}/judge')
    def score(identifier: str, payload: Selection):
        if not judge.status()['configured']:
            raise HTTPException(422, '请先配置裁判 API Key')
        return operation(lambda: imports.queue_assessments(store, identifier, payload.record_ids))

    @router.post('/batches/{identifier}/manage')
    def manage(identifier: str, payload: Manage):
        batch(identifier)
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            active = db.execute("SELECT 1 FROM answer_assessments a JOIN answer_records r USING(record_id) WHERE batch_id=? AND status IN ('queued','running')", (identifier,)).fetchone()
            if payload.action == 'delete' and active:
                raise HTTPException(409, '请等待评分完成，或取消排队项后再删除')
            if payload.action in {'pin', 'unpin'}:
                db.execute('UPDATE answer_batches SET pinned=? WHERE batch_id=?', (int(payload.action == 'pin'), identifier))
            elif payload.action == 'cancel':
                db.execute("UPDATE answer_assessments SET status='cancelled',finished_at=? WHERE status='queued' AND record_id IN (SELECT record_id FROM answer_records WHERE batch_id=?)", (now(), identifier))
            else:
                db.execute('UPDATE answer_batches SET deleted_at=? WHERE batch_id=?', (None if payload.action == 'restore' else now(), identifier))
        return {'updated': True}

    @router.get('/records/{identifier}')
    def record(identifier: str):
        return operation(lambda: imports.record_detail(store, identifier))

    @router.get('/records/{identifier}/compare')
    def compare(identifier: str, other: str):
        left, right = record(identifier), record(other)
        if [t['question'] for t in left['turns']] != [t['question'] for t in right['turns']]:
            raise HTTPException(422, '两份记录的完整用户问题不一致，不能作为同题对比')
        return {'left': left, 'right': right, 'note': '导入回答对比；执行环境与模型身份未核验，不代表受控运行'}

    @router.post('/regression', status_code=201)
    def regression(payload: Regression):
        if not payload.confirmed or not 1 <= len(payload.expectations) <= 100 or any(not v.strip() or len(v) > 4000 for v in payload.expectations.values()):
            raise HTTPException(422, '请为所选问题填写并确认期望，不会把现有回答自动当成标准答案')
        cases, version = [], 'v1'
        if payload.dataset_id:
            old = operation(lambda: store.get_dataset(payload.dataset_id))
            if old['profile'] != payload.profile or old['deleted_at']:
                raise HTTPException(422, '目标测试集不兼容或已删除')
            version = 'v' + str(int(old['version'][1:]) + 1)
            cases = [{**c, 'case_id': c.get('source_case_id') or c['case_id'], 'gold_status': 'engineering_draft'} for c in store.list_cases(payload.profile, payload.dataset_id)]
        for rid, expectation in payload.expectations.items():
            item = record(rid)
            turns = item['turns']
            if len(turns) > 12:
                raise HTTPException(422, '运行测试集目前最多 12 轮；请先整理要回归的完整场景')
            cases.append({'case_id': 'imported_' + uuid4().hex, 'title': turns[0]['question'][:80],
                'message': turns[0]['question'], 'category': 'imported_regression', 'synthetic': True,
                'turns': [{'message': t['question']} for t in turns] if len(turns) > 1 else [],
                'expected': {'behavior_expectation': expectation.strip(), 'imported_answer_record': rid,
                             'source_file_sha256': item['source']['sha256']}})
        result = operation(lambda: store.import_dataset(DatasetInput(name=payload.name, profile=payload.profile, version=version,
            description='从已脱敏回答提取；期望由用户确认，工程草案。' + (f'派生自 {payload.dataset_id}' if payload.dataset_id else ''),
            filename='answer-regression.json', content=json.dumps(cases, ensure_ascii=False))))
        if payload.profile == 'clinical':
            with store.connect() as db:
                db.execute('INSERT OR IGNORE INTO agent_datasets VALUES(?,?)', ('agent_clinical', result['dataset_id']))
        return result

    app.include_router(router)
