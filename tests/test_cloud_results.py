import base64
import json

import httpx
from fastapi.testclient import TestClient

from agent_evo.cloud_results import CloudSettings, create_cloud_app
from agent_evo.langfuse_sync import Connection


def settings():
    return CloudSettings('https://results.example.test', 'client-public', 'private-client-secret', '12345', 's' * 40,
        Connection('https://cloud.langfuse.com', 'pk-contract', 'sk-contract', 'project-contract'))


def oauth_mock(monkeypatch, owner='12345'):
    original = httpx.Client
    def handler(request):
        if request.url.host == 'github.com':
            assert b'code_verifier=' in request.content
            return httpx.Response(200, json={'access_token': 'contract-oauth-token'})
        assert request.url.host == 'api.github.com'
        return httpx.Response(200, json={'id': int(owner)})
    monkeypatch.setattr('agent_evo.cloud_results.httpx.Client', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))


def state(client):
    login = client.get('/auth/login', follow_redirects=False)
    assert login.status_code == 302
    assert 'code_challenge_method=S256' in login.headers['location']
    assert 'HttpOnly' in login.headers['set-cookie'] and 'Secure' in login.headers['set-cookie']
    cookie = client.cookies.get('__Host-evo-oauth').split('.')[0]
    return json.loads(base64.urlsafe_b64decode(cookie + '=' * (-len(cookie) % 4)))['state']


def test_cloud_is_closed_without_login_and_never_exposes_runner():
    app = create_cloud_app(settings())
    with TestClient(app, base_url='https://results.example.test') as client:
        response = client.get('/api/results/runs')
        assert response.status_code == 401
        assert response.headers['cache-control'] == 'private, no-store'
        assert 'sk-contract' not in response.text
        for path in ('/api/local-evaluations/scripts', '/api/local-evaluations/bootstrap', '/api/batches', '/api/visitor/runs'):
            assert client.post(path).status_code == 404
        assert client.get('/auth/callback?code=fake&state=fake').status_code == 401


def test_oauth_owner_allowlist_and_tamper_protection(monkeypatch):
    oauth_mock(monkeypatch, owner='99999')
    with TestClient(create_cloud_app(settings()), base_url='https://results.example.test') as client:
        nonce = state(client)
        assert client.get('/auth/callback', params={'code': 'contract', 'state': 'wrong'}, follow_redirects=False).status_code == 401
        assert client.get('/auth/callback', params={'code': 'contract', 'state': nonce}, follow_redirects=False).status_code == 403
        assert client.get('/api/results/status').status_code == 401


def test_owner_session_cookie_and_logout(monkeypatch):
    oauth_mock(monkeypatch)
    with TestClient(create_cloud_app(settings()), base_url='https://results.example.test') as client:
        nonce = state(client)
        callback = client.get('/auth/callback', params={'code': 'contract', 'state': nonce}, follow_redirects=False)
        assert callback.status_code == 302
        response = client.get('/api/results/status')
        assert response.status_code == 200
        assert response.json()['local_online'] == 'unknown'
        assert all(s not in response.text for s in ('contract-oauth-token', 'private-client-secret', 'sk-contract'))
        assert client.post('/auth/logout', headers={'Origin': 'https://evil.example'}).status_code == 403
        assert client.post('/auth/logout', headers={'Origin': 'https://results.example.test'}, follow_redirects=False).status_code == 303
        assert client.get('/api/results/status').status_code == 401
