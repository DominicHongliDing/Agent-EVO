from dataclasses import replace
from pathlib import Path
from fastapi.testclient import TestClient
from agent_evo.api import create_app
from agent_evo.config import Settings


def test_reviews_are_append_only_and_snapshot_scoped(tmp_path):
    app = create_app(replace(Settings.from_env(), db_path=tmp_path/'db.sqlite', artifact_root=tmp_path/'artifacts', access_token=''), start_worker=False)
    with TestClient(app) as client:
        uploaded = client.post('/api/answers/imports', headers={'X-EVO-Answers': '1'},
                               files={'file': ('answers.csv', Path('web/public/templates/answers.csv').read_bytes())}).json()
        batch = client.post('/api/answers/imports/'+uploaded['import_id']+'/commit', headers={'X-EVO-Answers': '1'},
                    json={'mapping': uploaded['mapping'], 'reviewed_deidentified': True, 'confirm_order': True, 'name': '模板验收'}).json()
        bid = batch['batch_id']
        snap = client.get('/api/reports/answers/'+bid).json()['snapshot']
        original = client.get('/api/answers/batches/'+bid).json()
        payload = {'record_id': snap['units'][0]['id'], 'snapshot_id': snap['snapshot_id'], 'status': 'confirmed', 'reason': '核对原文后保留待核验问题'}
        url = '/api/decisions/answers/'+bid
        assert client.post(url, json=payload).status_code == 403
        headers = {'X-EVO-Decisions': '1'}
        assert client.post(url, headers=headers, json={**payload, 'snapshot_id': 'old'}).status_code == 409
        assert client.post(url, headers=headers, json={**payload, 'record_id': 'other-project'}).status_code == 422
        assert client.post(url, headers=headers, json=payload).status_code == 200
        assert client.post(url, headers=headers, json={**payload, 'status': 'disputed', 'reason': '重新核对后不同意原判断'}).status_code == 200
        history = client.get(url).json()['items']
        assert [r['status'] for r in history] == ['disputed', 'confirmed']
        assert client.get('/api/answers/batches/'+bid).json() == original
        assert client.post(url, headers=headers, json={**payload, 'status': 'resolved'}).status_code == 422


def test_both_answer_templates_keep_multiturn_and_chinese(tmp_path):
    from agent_evo.answer_imports import parse_file
    for suffix in ['csv', 'xlsx']:
        filename = 'answers.'+suffix
        parsed = parse_file(filename, Path('web/public/templates/'+filename).read_bytes())
        assert len(parsed['rows']) == 4
        assert any('周四' in str(r) for r in parsed['rows'])
