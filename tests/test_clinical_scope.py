from dataclasses import replace

from fastapi.testclient import TestClient

from agent_evo.api import create_app
from agent_evo.config import Settings


def test_clinical_scope_filters_mixed_history_counts_and_blocks_hr_links(tmp_path):
    app = create_app(replace(Settings.from_env(), db_path=tmp_path / 'evo.db', access_token=''), start_worker=False)
    store = app.state.store
    clinical, hr = store.list_cases('clinical')[0], store.list_cases('unihr')[0]
    mixed = store.create_batch([clinical['case_id'], hr['case_id']], '双 Agent 历史')
    clinical_id, hr_id = [r['run_id'] for r in mixed['runs']]
    store.set_run_fields(clinical_id, status='completed')
    store.set_run_fields(hr_id, status='failed')
    store.add_verdict(hr_id, 'critical_safety', 'deterministic-v1', 'fail', 'HR 独立历史证据', [], critical=True)
    store.add_verdict(clinical_id, 'retrieval', 'deterministic-v1', 'fail', 'Clinical 资料未命中', [])
    source = store.get_batch(mixed['batch_id'])
    hr_only = store.create_batch([hr['case_id']], 'HR 历史')
    with TestClient(app, base_url='http://127.0.0.1:8090') as client:
        assert all(c['agent'] == 'clinical' for c in client.get('/api/cases').json()['items'])
        assert all(d['profile'] == 'clinical' for d in client.get('/api/datasets').json()['items'])
        rows = client.get('/api/batches').json()['items']
        assert len(rows) == 1 and rows[0]['total'] == 1 and rows[0]['finished'] == 1
        assert rows[0]['runs'][0]['run_id'] == clinical_id
        assert client.get('/api/batches/' + hr_only['batch_id']).status_code == 404
        assert client.get('/api/runs/' + hr_id).status_code == 404
        assert client.post('/api/runs/' + hr_id + '/retry').status_code == 404
        token = client.get('/api/local-evaluations/bootstrap', headers={'X-EVO-Bootstrap': '1'}).json()['token']
        assert client.post('/api/local-evaluations/runs/' + hr_id + '/retry', headers={'X-EVO-Local-Token': token}).status_code == 422
        assert client.get('/api/runs').json()['items'][0]['run_id'] == clinical_id
        report = client.get('/api/batches/' + mixed['batch_id'] + '/report').json()
        assert report['total'] == 1 and set(report['by_agent']) == {'clinical'}
        assert not report['critical_failures'] and report['dimensions']['retrieval']['fail'] == 1
        issues = client.get('/api/batches/' + mixed['batch_id'] + '/failures').json()
        assert issues['total'] == issues['assertion_count'] == 1
        assert issues['items'][0]['run_id'] == clinical_id
        assert client.post('/api/batches', json={'case_ids': [hr['case_id']], 'label': 'HR'}).status_code == 403
        assert client.post('/api/visitor/sessions', json={'project': 'unihr'}).status_code == 403
    assert store.get_batch(mixed['batch_id']) == source
    assert store.verdicts(hr_id)[0]['rationale'] == 'HR 独立历史证据'
