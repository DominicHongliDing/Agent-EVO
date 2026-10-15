from dataclasses import replace

from fastapi.testclient import TestClient

from agent_evo.api import create_app
from agent_evo.config import Settings


def test_fixed_agent_mutations_and_non_builtin_execution_are_rejected(tmp_path):
    app = create_app(replace(Settings.from_env(), db_path=tmp_path / 'evo.db', artifact_root=tmp_path / 'artifacts'), start_worker=False)
    with TestClient(app) as client:
        assert {a['agent_id'] for a in client.get('/api/agents').json()['items']} == {'agent_clinical'}
        payload = {'name': 'arbitrary', 'adapter_kind': 'http_json', 'base_url': 'http://127.0.0.1:8010'}
        assert client.post('/api/agents', json=payload).status_code == 403
        assert client.patch('/api/agents/agent_clinical', json=payload).status_code == 403
        assert client.post('/api/agents/agent_unihr/delete').status_code == 403
        assert client.post('/api/batches', json={'agent_id': 'extra', 'case_ids': ['example']}).status_code == 403
        assert client.post('/api/agents/extra/check').status_code == 403
        assert client.post('/api/visitor/arbitrary', json={'key': 'placeholder'}).status_code == 404
        assert client.post('/api/batches', json={'agent_id': 'agent_clinical', 'case_ids': ['missing']}).status_code == 400
