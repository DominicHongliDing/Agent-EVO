"""Separate, read-only online service. No local runner, database or upload routes."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from agent_evo.langfuse_sync import Connection, quality, stable, export_payload, verify_remote


def encode(value: bytes):
    return base64.urlsafe_b64encode(value).decode().rstrip('=')


@dataclass(repr=False)
class CloudSettings:
    public_url: str
    github_client_id: str
    github_client_secret: str
    github_owner_id: str
    session_secret: str
    langfuse: Connection

    @classmethod
    def from_env(cls):
        return cls(os.environ['EVO_RESULTS_PUBLIC_URL'].rstrip('/'), os.environ['EVO_GITHUB_CLIENT_ID'],
            os.environ['EVO_GITHUB_CLIENT_SECRET'], os.environ['EVO_GITHUB_OWNER_ID'], os.environ['EVO_SESSION_SECRET'],
            Connection(os.environ['LANGFUSE_BASE_URL'], os.environ['LANGFUSE_PUBLIC_KEY'], os.environ['LANGFUSE_SECRET_KEY'], os.environ['LANGFUSE_PROJECT_ID']))


def create_cloud_app(settings=None):
    settings = settings or CloudSettings.from_env()
    if len(settings.session_secret) < 32 or urlsplit(settings.public_url).scheme != 'https' or not settings.github_owner_id.isdigit():
        raise ValueError('线上服务需要 HTTPS 地址、固定 GitHub 用户 ID 和至少 32 字符的会话密钥')
    app = FastAPI(title='Agent EVO Private Results', docs_url=None, redoc_url=None, openapi_url=None)

    def sign(data):
        body = encode(json.dumps(data, separators=(',', ':')).encode())
        return body + '.' + encode(hmac.new(settings.session_secret.encode(), body.encode(), hashlib.sha256).digest())

    def unpack(cookie, purpose):
        try:
            body, signature = cookie.split('.')
            expected = encode(hmac.new(settings.session_secret.encode(), body.encode(), hashlib.sha256).digest())
            if not hmac.compare_digest(signature, expected):
                raise ValueError()
            payload = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))
            if payload['purpose'] != purpose or payload['expires'] < time.time():
                raise ValueError()
            return payload
        except (ValueError, KeyError, TypeError):
            raise HTTPException(401, '请先登录私有结果空间') from None

    def owner(request: Request):
        identity = unpack(request.cookies.get('__Host-evo-session', ''), 'session')
        if identity.get('owner') != settings.github_owner_id:
            raise HTTPException(403, '此账号没有该结果空间的访问权限')

    @app.middleware('http')
    async def headers(request, call_next):
        response = await call_next(request)
        response.headers['Cache-Control'] = 'private, no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['X-Frame-Options'] = 'DENY'
        return response

    @app.get('/auth/login')
    def login():
        state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
        query = urlencode({'client_id': settings.github_client_id, 'redirect_uri': settings.public_url + '/auth/callback',
            'state': state, 'code_challenge': encode(hashlib.sha256(verifier.encode()).digest()), 'code_challenge_method': 'S256', 'scope': '', 'allow_signup': 'false'})
        response = RedirectResponse('https://github.com/login/oauth/authorize?' + query, 302)
        response.set_cookie('__Host-evo-oauth', sign({'purpose': 'oauth', 'state': state, 'verifier': verifier, 'expires': time.time() + 600}),
            max_age=600, secure=True, httponly=True, samesite='lax', path='/')
        return response

    @app.get('/auth/callback')
    def callback(request: Request, code: str, state: str):
        pending = unpack(request.cookies.get('__Host-evo-oauth', ''), 'oauth')
        if not hmac.compare_digest(state, pending['state']):
            raise HTTPException(401, '登录校验失败，请重新登录')
        try:
            with httpx.Client(timeout=20, trust_env=False, follow_redirects=False) as client:
                response = client.post('https://github.com/login/oauth/access_token', headers={'Accept': 'application/json'},
                    data={'client_id': settings.github_client_id, 'client_secret': settings.github_client_secret, 'code': code,
                        'redirect_uri': settings.public_url + '/auth/callback', 'code_verifier': pending['verifier']})
                response.raise_for_status()
                token = response.json()['access_token']
                identity = client.get('https://api.github.com/user', headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json'})
                identity.raise_for_status()
                user_id = str(identity.json()['id'])
        except (httpx.HTTPError, KeyError, ValueError):
            raise HTTPException(401, '无法验证 GitHub 身份，请重试') from None
        if user_id != settings.github_owner_id:
            raise HTTPException(403, '此账号没有该结果空间的访问权限')
        response = RedirectResponse('/?space=local-results', 302)
        response.delete_cookie('__Host-evo-oauth', path='/', secure=True, httponly=True, samesite='lax')
        response.set_cookie('__Host-evo-session', sign({'purpose': 'session', 'owner': user_id, 'expires': time.time() + 28800}),
            max_age=28800, secure=True, httponly=True, samesite='lax', path='/')
        return response

    @app.post('/auth/logout', dependencies=[Depends(owner)])
    def logout(request: Request):
        if request.headers.get('origin') != settings.public_url:
            raise HTTPException(403, '跨站请求已拒绝')
        response = RedirectResponse('/?space=local-results', 303)
        response.delete_cookie('__Host-evo-session', path='/', secure=True, httponly=True, samesite='lax')
        return response

    def read_records(days):
        end = datetime.now(timezone.utc) + timedelta(minutes=1)
        try:
            observations = settings.langfuse.observations(fromStartTime=(end - timedelta(days=days)).isoformat(), toStartTime=end.isoformat(),
                environment='evo-local', name='Clinical 评测记录', isRootObservation='true')
        except (httpx.HTTPError, ValueError, KeyError):
            raise HTTPException(502, '云端记录暂时无法读取；请稍后重试') from None
        records = []
        for observation in observations:
            metadata = observation.get('metadata') or {}
            record = metadata.get('evo_record')
            try:
                record = json.loads(record) if isinstance(record, str) else record
                if not isinstance(record, dict) or record.get('case', {}).get('agent') != 'clinical':
                    continue
                from agent_evo.store import dumps
                if stable(dumps(record), 64) != metadata.get('evo_revision'):
                    continue
                record.update(quality=quality(record), sync={'state': 'record_available'},
                    langfuse_url=settings.langfuse.host + '/project/' + settings.langfuse.project_id + '/traces/' + record['trace_id'])
                records.append(record)
            except (ValueError, TypeError, KeyError):
                continue
        return sorted(records, key=lambda r: r.get('started_at') or r.get('finished_at') or '', reverse=True)

    @app.get('/api/results/status', dependencies=[Depends(owner)])
    def status():
        return {'connected': True, 'host': settings.langfuse.host, 'project_id': settings.langfuse.project_id, 'mode': 'cloud', 'local_online': 'unknown'}

    @app.get('/api/results/batches', dependencies=[Depends(owner)])
    def batches():
        end = datetime.now(timezone.utc) + timedelta(minutes=1)
        try:
            rows = settings.langfuse.observations(fromStartTime=(end - timedelta(days=366)).isoformat(), toStartTime=end.isoformat(),
                environment='evo-control', name='EVO 批次进度', isRootObservation='true')
            result = []
            from agent_evo.store import dumps
            for row in rows:
                metadata = row.get('metadata') or {}
                control = metadata.get('evo_batch_control')
                control = json.loads(control) if isinstance(control, str) else control
                if not isinstance(control, dict) or stable(dumps(control), 64) != metadata.get('evo_revision'):
                    continue
                seen = control.get('last_seen_at')
                recent = seen and (datetime.now(timezone.utc) - datetime.fromisoformat(seen)).total_seconds() <= 60
                control['connection_state'] = ('recently_seen' if recent else 'stale') if control['active_at_last_update'] else 'finished'
                result.append(control)
            return {'items': result}
        except (httpx.HTTPError, ValueError, KeyError, TypeError):
            raise HTTPException(502, '批次进度暂时不可读取，当前执行状态未知') from None

    @app.get('/api/results/runs', dependencies=[Depends(owner)])
    def runs(days: int = 90):
        if not 1 <= days <= 366:
            raise HTTPException(422, '时间范围须为 1–366 天')
        return {'items': read_records(days)}

    @app.get('/api/results/runs/{run_id}', dependencies=[Depends(owner)])
    def run_detail(run_id: str):
        # No user-controlled upstream URL or project parameter.
        for record in read_records(366):
            if record['run_id'] == run_id:
                source = {k: v for k, v in record.items() if k not in {'quality', 'sync', 'langfuse_url'}}
                try:
                    revision, payload = export_payload(source)
                    verified, missing = verify_remote(settings.langfuse, payload, revision)
                    record['sync'] = {'state': 'verified' if verified else 'partial', 'missing': missing}
                except (httpx.HTTPError, ValueError, KeyError, TypeError):
                    record['sync'] = {'state': 'record_available', 'last_error': '完整记录可读，轨迹与评分的核验暂时不可用'}
                return record
        raise HTTPException(404, '记录不存在、尚未完成索引或不在读取时间范围内')

    @app.api_route('/api/{path:path}', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
    def unavailable(path: str):
        raise HTTPException(404, '线上结果服务不提供脚本上传、执行或任意代理接口')

    static = Path(__file__).resolve().parents[2] / 'web/dist'
    if static.is_dir():
        @app.get('/')
        def index(request: Request):
            if request.query_params.get('space') != 'local-results':
                return RedirectResponse('/?space=local-results', 302)
            return FileResponse(static / 'index.html')
        app.mount('/', StaticFiles(directory=static, html=True), name='private-results-ui')
    return app
