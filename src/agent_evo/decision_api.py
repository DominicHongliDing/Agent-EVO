"""Append-only business review notes. Original judgements are never overwritten."""
import json
from uuid import uuid4
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from agent_evo.reporting import snapshot
from agent_evo.store import now, dumps


class ReviewNote(BaseModel):
    record_id: str = Field(min_length=1, max_length=150)
    snapshot_id: str = Field(min_length=1, max_length=100)
    status: Literal['confirmed', 'disputed', 'insufficient', 'planned', 'retest']
    priority: Literal['urgent', 'planned', 'experience'] = 'planned'
    reason: str = Field(min_length=2, max_length=4000)
    impact: str = Field(default='', max_length=2000)
    action: str = Field(default='', max_length=2000)
    owner: str = Field(default='', max_length=100)


def install(app, store, access):
    with store.connect() as db:
        db.execute('''CREATE TABLE IF NOT EXISTS decision_reviews (
          id TEXT PRIMARY KEY, source TEXT NOT NULL, batch_id TEXT NOT NULL,
          record_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)''')

    async def guard(request: Request):
        await access(request)
        if request.method != 'GET' and request.headers.get('X-EVO-Decisions') != '1':
            raise HTTPException(403, '请从评测工作台提交审核')
    router = APIRouter(prefix='/api/decisions', dependencies=[Depends(guard)])

    def current(source, batch_id):
        if source not in {'native', 'answers'}:
            raise HTTPException(404, '评测来源不存在')
        try:
            return snapshot(store, source, batch_id)
        except (KeyError, ValueError):
            raise HTTPException(404, '评测记录不存在') from None

    @router.get('/{source}/{batch_id}')
    def reviews(source: str, batch_id: str):
        current(source, batch_id)
        with store.connect() as db:
            return {'items': [json.loads(r['payload']) for r in db.execute(
                'SELECT payload FROM decision_reviews WHERE source=? AND batch_id=? ORDER BY rowid DESC', (source, batch_id))]}

    @router.post('/{source}/{batch_id}')
    def review(source: str, batch_id: str, body: ReviewNote):
        snap = current(source, batch_id)
        if body.snapshot_id != snap['snapshot_id']:
            raise HTTPException(409, '评分已变化，请刷新后再审核当前证据')
        if body.record_id not in {u['id'] for u in snap['units']}:
            raise HTTPException(422, '这条记录不属于当前批次')
        if not body.reason.strip():
            raise HTTPException(422, '请说明判断依据')
        row = {**body.model_dump(), 'id': 'review_'+uuid4().hex, 'created_at': now(), 'actor': '本地工作区用户'}
        with store.connect() as db:
            db.execute('INSERT INTO decision_reviews VALUES(?,?,?,?,?,?)', (row['id'], source, batch_id, body.record_id, row['created_at'], dumps(row)))
        return row
    app.include_router(router)
