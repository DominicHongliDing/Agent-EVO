from __future__ import annotations

import io
import json
import stat
import os
import signal
import subprocess
import sys
import threading
import time
import zipfile
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from agent_evo.api import create_app
from agent_evo.config import Settings
from agent_evo.langfuse_sync import Connection, SyncWorker, export_payload, queue_export, snapshot
from agent_evo.runner import execute_one
from agent_evo.script_store import binding, get_script, import_script, root, update_binding, verify_script
from agent_evo.store import Store, dumps, now


@pytest.fixture(autouse=True)
def disable_paid_judge(monkeypatch):
    monkeypatch.setenv('EVO_CONTEXT_JUDGE_ENABLED', '0')


def config(tmp_path):
    return replace(Settings.from_env(), db_path=tmp_path / 'evo.db', artifact_root=tmp_path / 'artifacts', access_token='',
                   clinical_source=tmp_path / 'clinical-source', clinical_access_token='')


def starter(store, code=b'def run_case(case, context):\n    return context.call_agent()\n', timeout=10):
    script = import_script(store, 'clinical.py', code)
    available = [c for c in store.list_cases('clinical') if not c.get('case_context_text')]
    case = next((c for c in available if c['risk_level'] == 'critical'), available[0])
    batch = store.create_managed_batch([case['case_id']], 'contract fixture', script={
        'script_id': script['script_id'], 'interpreter': sys.executable, 'timeout_seconds': timeout, 'sync_enabled': True})
    return script, batch['runs'][0]['run_id']


def test_import_does_not_execute_and_versions_are_frozen(tmp_path):
    store = Store(config(tmp_path))
    marker = tmp_path / 'should-not-exist'
    code = f'from pathlib import Path\nPath({str(marker)!r}).write_text("executed")\ndef run_case(case, context): return context.call_agent()\n'.encode()
    script = import_script(store, 'example.py', code)
    assert not marker.exists()
    assert import_script(store, 'example.py', code)['script_id'] == script['script_id']
    verify_script(store, script)
    (root(store) / script['script_id'] / 'evaluation.py').write_text('changed')
    with pytest.raises(ValueError, match='修改'):
        verify_script(store, script)


@pytest.mark.parametrize('name', ['../escape.py', '/escape.py', 'C:/escape.py', '.env', '.env.production', 'folder\\escape.py', 'CON.py', 'folder./x.py'])
def test_rejects_unsafe_archives(tmp_path, name):
    store = Store(config(tmp_path))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr(name, 'secret')
    with pytest.raises(ValueError):
        import_script(store, 'script.zip', buffer.getvalue())


def test_zip_symlink_and_bomb_and_syntax_rejected(tmp_path):
    store = Store(config(tmp_path))
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        info = zipfile.ZipInfo('link.py')
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(info, '/tmp/target')
    with pytest.raises(ValueError):
        import_script(store, 'bad.zip', buffer.getvalue())
    with pytest.raises(ValueError):
        import_script(store, 'bad.py', b'def ???')
    with pytest.raises(ValueError):
        import_script(store, 'bad.py', b'x' * (5*1024*1024 + 1))


def test_local_security_and_explicit_execution(tmp_path):
    app = create_app(config(tmp_path), start_worker=False)
    with TestClient(app, base_url='http://127.0.0.1:8090') as client:
        base = '/api/local-evaluations'
        assert client.get(base + '/scripts').status_code == 401
        assert client.get(base + '/bootstrap').status_code == 403
        assert client.get(base + '/bootstrap', headers={'X-EVO-Bootstrap': '1', 'Host': 'evil.example'}).status_code == 403
        assert client.get(base + '/bootstrap', headers={'X-EVO-Bootstrap': '1', 'Origin': 'https://evil.example'}).status_code == 403
        bootstrap = client.get(base + '/bootstrap', headers={'X-EVO-Bootstrap': '1'})
        assert bootstrap.headers['cache-control'] == 'no-store'
        token = bootstrap.json()['token']
        headers = {'X-EVO-Local-Token': token}
        assert client.post(base + '/scripts', headers=headers, files={'file': ('ok.py', b'def run_case(case, context): return context.call_agent()')}).status_code == 201
        script, run_id = starter(app.state.store)
        assert client.post('/api/runs/' + run_id + '/cancel').status_code == 401
        assert client.post(base + '/runs/' + run_id + '/cancel', headers={**headers, 'Origin': 'https://evil.example'}).status_code == 403
        assert client.post(base + '/runs/' + run_id + '/cancel', headers=headers).status_code == 200


def test_unified_builtin_mode_does_not_require_script_or_script_trust(tmp_path, clinical_contract_server):
    address, requests = clinical_contract_server
    app = create_app(replace(config(tmp_path), clinical_url=address), start_worker=False)
    store = app.state.store
    case = store.list_cases('clinical')[0]
    with TestClient(app, base_url='http://127.0.0.1:8090') as client:
        token = client.get('/api/local-evaluations/bootstrap', headers={'X-EVO-Bootstrap': '1'}).json()['token']
        headers = {'X-EVO-Local-Token': token}
        payload = {'dataset_id': case['dataset_id'], 'case_ids': [case['case_id']], 'label': 'Clinical 内置方式',
                   'interpreter': '', 'sync_enabled': True}
        assert client.post('/api/local-evaluations/batches', json=payload, headers=headers).status_code == 422
        response = client.post('/api/local-evaluations/batches', json={**payload, 'reviewed_deidentified': True}, headers=headers)
        assert response.status_code == 201
        run_id = response.json()['runs'][0]['run_id']
    assert binding(store, run_id) is None
    with store.connect() as db:
        assert db.execute('SELECT enabled FROM sync_exports WHERE run_id=?', (run_id,)).fetchone()[0] == 1
    assert not requests


@pytest.fixture
def clinical_contract_server():
    """Real HTTP, simulated business responses. Never counted as a live model test."""
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def response(self, data, sse=False):
            encoded = (('data: ' + json.dumps(data) + '\n\n') if sse else json.dumps(data)).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream' if sse else 'application/json')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            if self.path == '/auth/register':
                return self.response({'user': {'user_id': 'contract-user'}})
            if self.path == '/auth/login':
                return self.response({'access_token': 'contract-only-token'})
            assert self.path == '/chat/stream'
            requests.append(body)
            return self.response({'type': 'final', 'response': {'run_id': f'contract-{len(requests)}',
                'thread_id': body['thread_id'], 'answer': '保留的业务回答', 'trace': {'intent': 'general_qa',
                    'model_usage': {'successful_request_count': 1, 'events': [{'model_name': 'contract-simulator', 'status': 'success'}]}}}}, True)

        def do_GET(self):
            return self.response({'user': {'user_id': 'contract-user'}} if self.path == '/auth/me' else {'items': []})

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f'http://127.0.0.1:{server.server_port}', requests
    server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_subprocess_calls_adapter_and_preserves_output_on_evaluator_failure(tmp_path, clinical_contract_server):
    address, requests = clinical_contract_server
    settings = replace(config(tmp_path), clinical_url=address)
    store = Store(settings)
    _, run_id = starter(store, b'def run_case(case, context):\n    return context.call_agent()\ndef evaluate_case(case, result, context):\n    raise RuntimeError("judge unavailable")\n')
    execute_one(store.claim_next('test'), store, settings)
    run = store.get_run(run_id)
    assert len(requests) == 1
    assert run['status'] == 'completed'
    assert run['output']['result']['answer'] == '保留的业务回答'
    assert run['business_run_id'] == 'contract-1'
    assert binding(store, run_id)['evaluator_status'] == 'failed'
    assert any(v['critical'] for v in store.verdicts(run_id))
    assert any(e['node'] == 'script.evaluate' for e in store.events(run_id))


def test_subprocess_multiturn_uses_one_session_and_retry_gets_new_session(tmp_path, clinical_contract_server):
    address, requests = clinical_contract_server
    datasets = tmp_path / 'dataset'
    datasets.mkdir()
    case = {'case_id': 'clinical_turns_v1', 'agent': 'clinical', 'category': 'context', 'title': '睡眠问题',
        'message': '最近两周睡不着怎么办？', 'turns': [{'message': '最近两周睡不着怎么办？'}, {'message': '我记错了，是三天。现在应该记录什么？'}]}
    (datasets / 'case.jsonl').write_text(dumps(case), encoding='utf-8')
    settings = replace(config(tmp_path), dataset_root=datasets, clinical_url=address)
    store = Store(settings)
    _, run_id = starter(store)
    execute_one(store.claim_next('test'), store, settings)
    assert len(requests) == 2
    assert requests[0]['thread_id'] == requests[1]['thread_id']
    rows = store.get_run(run_id)['output']['conversation_turns']
    assert all(r['session_verified'] for r in rows)
    replacement = store.retry(run_id)
    assert binding(store, replacement['run_id'])['script_id'] == binding(store, run_id)['script_id']
    execute_one(store.claim_next('test'), store, settings)
    assert len(requests) == 4
    assert requests[2]['thread_id'] != requests[0]['thread_id']


def test_cancellation_stops_child_and_does_not_rerun_after_recovery(tmp_path):
    store = Store(config(tmp_path))
    marker = tmp_path / 'cancelled-child-ran.txt'
    code = f'import time\nfrom pathlib import Path\ndef run_case(case, context):\n    time.sleep(2)\n    Path({str(marker)!r}).write_text("continued")\n    return context.call_agent()\n'.encode()
    _, run_id = starter(store, code)
    claimed = store.claim_next('test')
    thread = threading.Thread(target=execute_one, args=(claimed, store, store.settings))
    thread.start()
    deadline = time.monotonic() + 10
    while binding(store, run_id)['process_status'] != 'running' and time.monotonic() < deadline:
        time.sleep(.05)
    update_binding(store, run_id, cancel_requested=1)
    thread.join(timeout=10)
    assert not thread.is_alive()
    assert store.get_run(run_id)['error_code'] == 'script_cancelled_result_unknown'
    assert store.get_run(run_id)['model_calls'] == 0
    time.sleep(2.3)
    assert not marker.exists()
    store.mark_interrupted()
    assert store.claim_next('restart') is None


def completed_record(tmp_path):
    store = Store(config(tmp_path))
    case = store.list_cases('clinical')[0]
    store.create_batch([case['case_id']], 'historic')
    run = store.claim_next('test')
    store.set_run_fields(run['run_id'], status='completed', finished_at=now(), output_json=dumps({'answer': '保留输出', 'api_key': 'must-not-export'}))
    store.add_event(run['run_id'], 'business', 'retrieve', 'completed', {'query': '材料', 'candidates': ['doc-a'], 'secret': 'do-not-export'})
    store.add_verdict(run['run_id'], 'retrieval', 'rules-v1', 'fail', '资料未匹配', ['event:1'], critical=True)
    with store.connect() as db:
        db.execute('INSERT INTO sync_exports(run_id,enabled,updated_at) VALUES(?,1,?)', (run['run_id'], now()))
    return store, run['run_id']


def test_durable_export_idempotency_and_original_time(tmp_path):
    store, run_id = completed_record(tmp_path)
    queue_export(store, run_id)
    record = snapshot(store, run_id)
    before = export_payload(record)
    restarted = Store(store.settings)
    queue_export(restarted, run_id)
    after = export_payload(snapshot(restarted, run_id))
    assert before == after
    with store.connect() as db:
        assert db.execute('SELECT count(*) FROM sync_outbox').fetchone()[0] == 1
        payload = db.execute('SELECT payload_json FROM sync_outbox').fetchone()[0]
    assert 'must-not-export' not in payload and 'do-not-export' not in payload
    assert before[1]['scores'][0]['timestamp'] == store.verdicts(run_id)[0]['created_at']
    assert store.get_run(run_id)['model_calls'] == 0


def test_record_list_reads_summaries_without_loading_full_traces(tmp_path, monkeypatch):
    store, run_id = completed_record(tmp_path)
    queue_export(store, run_id)
    app = create_app(store.settings, start_worker=False)

    def reject_full_trace(*args, **kwargs):
        raise AssertionError('List refresh must not load full trace evidence')

    monkeypatch.setattr('agent_evo.script_api.snapshot', reject_full_trace)
    with TestClient(app, base_url='http://127.0.0.1:8090') as client:
        token = client.get('/api/local-evaluations/bootstrap', headers={'X-EVO-Bootstrap': '1'}).json()['token']
        response = client.get('/api/local-evaluations/runs', headers={'X-EVO-Local-Token': token})
    assert response.status_code == 200
    item = next(r for r in response.json()['items'] if r['run_id'] == run_id)
    assert item['case']['agent'] == 'clinical'
    assert item['status'] == 'completed' and item['quality'] == 'fail'
    assert item['sync']['state'] == 'pending'
    assert 'output' not in item and 'events' not in item


class ContractConnection:
    host = 'https://contract.invalid'
    project_id = 'contract-project'
    def __init__(self):
        self.sent = []; self.ready = False; self.scores = []
    def request(self, method, path, **kwargs):
        if method == 'POST':
            self.sent.append((path, kwargs['json']))
            if path == '/ingestion':
                event = kwargs['json']['batch'][0]
                self.scores.append({**event['body'], 'timestamp': event['timestamp']})
            return {}
        return {'data': self.scores, 'meta': {}}
    def observations(self, **kwargs):
        if not self.ready:
            return []
        spans = next(body for path, body in self.sent if path == '/otel/v1/traces')['resourceSpans'][0]['scopeSpans'][0]['spans']
        rows = []
        for span in spans:
            metadata = {a['key'].split('langfuse.observation.metadata.')[1]: a['value']['stringValue'] for a in span['attributes'] if a['key'].startswith('langfuse.observation.metadata.')}
            output = next(a['value']['stringValue'] for a in span['attributes'] if a['key'] == 'langfuse.observation.output')
            rows.append({'id': span['spanId'], 'metadata': metadata, 'output': output})
        return rows


def test_ack_is_not_verified_and_index_poll_does_not_resend(tmp_path):
    store, run_id = completed_record(tmp_path)
    worker = SyncWorker(store)
    worker.connection = ContractConnection()
    worker.tick()
    with store.connect() as db:
        assert db.execute('SELECT state FROM sync_outbox').fetchone()[0] == 'indexing'
        db.execute('UPDATE sync_outbox SET next_attempt=0')
    sent = len(worker.connection.sent)
    worker.connection.ready = True
    worker.tick()
    with store.connect() as db:
        assert db.execute("SELECT state FROM sync_outbox WHERE kind='record'").fetchone()[0] == 'verified'
    assert len(worker.connection.sent) == sent
    assert store.get_run(run_id)['model_calls'] == 0


def test_wrong_project_and_auth_failures_require_attention(tmp_path):
    store, run_id = completed_record(tmp_path)
    worker = SyncWorker(store)
    connection = ContractConnection()
    worker.connection = connection
    def denied(method, path, **kwargs):
        response = httpx.Response(401, request=httpx.Request('POST', 'https://contract.invalid'))
        raise httpx.HTTPStatusError('denied', request=response.request, response=response)
    connection.request = denied
    worker.tick()
    with store.connect() as db:
        row = db.execute('SELECT state,last_error FROM sync_outbox').fetchone()
    assert row['state'] == 'needs_action' and row['last_error'] == 'langfuse_http_401'
    assert store.get_run(run_id)['model_calls'] == 0


def test_rescoring_never_repeats_business_and_preserves_prior_verdicts(tmp_path, clinical_contract_server):
    from agent_evo.script_runtime import execute_script
    address, requests = clinical_contract_server
    settings = replace(config(tmp_path), clinical_url=address)
    store = Store(settings)
    _, run_id = starter(store, b'def run_case(case, context): return context.call_agent()\ndef evaluate_case(case, result, context): return [{"dimension":"custom_review","result":"unjudged","rationale":"manual review","evidence":["output"]}]\n')
    execute_one(store.claim_next('test'), store, settings)
    before = store.get_run(run_id)
    old_ids = {v['verdict_id'] for v in store.verdicts(run_id)}
    execute_script(before, store, settings, rescore=True)
    after = store.get_run(run_id)
    assert len(requests) == 1
    assert before['output'] == after['output']
    assert before['business_run_id'] == after['business_run_id']
    assert old_ids < {v['verdict_id'] for v in store.verdicts(run_id)}
    assert binding(store, run_id)['evaluator_status'] == 'completed'


def test_partial_payload_is_not_claimed_as_verified(tmp_path):
    store, run_id = completed_record(tmp_path)
    worker = SyncWorker(store)
    connection = ContractConnection()
    connection.ready = True
    worker.connection = connection
    original = connection.observations
    def truncated(**kwargs):
        rows = original(**kwargs)
        rows[0]['output'] = 'truncated'
        return rows
    connection.observations = truncated
    worker.tick()
    with store.connect() as db:
        row = db.execute('SELECT state,last_error FROM sync_outbox').fetchone()
    assert row['state'] == 'partial'
    assert 'payload_mismatch' in row['last_error']


def test_destination_cannot_change_after_a_new_scoring_revision(tmp_path):
    store, run_id = completed_record(tmp_path)
    worker = SyncWorker(store)
    connection = ContractConnection()
    worker.connection = connection
    worker.tick()
    count = len(connection.sent)
    connection.project_id = 'another-project'
    store.add_verdict(run_id, 'new', 'human', 'unjudged', 'more review', ['output'])
    worker.tick()
    worker.tick()
    with store.connect() as db:
        row = db.execute('SELECT state,last_error FROM sync_outbox ORDER BY created_at DESC LIMIT 1').fetchone()
    assert row['state'] == 'needs_action' and row['last_error'] == 'destination_changed'
    assert len(connection.sent) == count


def test_batch_controls_are_separate_from_cases_and_have_no_experiment_membership(tmp_path):
    from agent_evo.langfuse_sync import queue_batch_controls
    store, run_id = completed_record(tmp_path)
    queue_export(store, run_id)
    queue_batch_controls(store)
    queue_batch_controls(store)
    with store.connect() as db:
        rows = db.execute("SELECT * FROM sync_outbox WHERE kind LIKE 'batch_control:%'").fetchall()
    assert len(rows) == 1
    payload = json.loads(rows[0]['payload_json'])
    assert payload['control'] and not payload['scores']
    assert 'langfuse.experiment.' not in dumps(payload)
    assert payload['trace_id'] != store.get_run(run_id)['trace_id']


def test_script_feature_flag_preserves_queue(tmp_path, monkeypatch):
    store = Store(config(tmp_path))
    _, run_id = starter(store)
    monkeypatch.setenv('EVO_LOCAL_SCRIPTS_ENABLED', '0')
    assert store.claim_next('disabled') is None
    assert store.get_run(run_id)['status'] == 'queued'
    monkeypatch.setenv('EVO_LOCAL_SCRIPTS_ENABLED', '1')
    assert store.claim_next('enabled')['run_id'] == run_id


def test_child_exits_when_platform_process_dies(tmp_path):
    settings = config(tmp_path)
    store = Store(settings)
    marker = tmp_path / 'orphan-ran.txt'
    code = f'import time\nfrom pathlib import Path\ndef run_case(case, context):\n    time.sleep(4)\n    Path({str(marker)!r}).write_text("orphan")\n    return context.call_agent()\n'.encode()
    _, run_id = starter(store, code)
    program = '''import os,sys
from pathlib import Path
from dataclasses import replace
from agent_evo.config import Settings
from agent_evo.store import Store
from agent_evo.runner import execute_one
settings=replace(Settings.from_env(),db_path=Path(sys.argv[1]),artifact_root=Path(sys.argv[2]))
store=Store(settings)
print(os.getpid(),flush=True)
execute_one(store.claim_next('orphan-check'),store,settings)
'''
    parent = subprocess.Popen([sys.executable, '-I', '-c', program, str(settings.db_path), str(settings.artifact_root)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    real_pid = int(parent.stdout.readline())
    try:
        deadline = time.monotonic() + 10
        while binding(store, run_id)['process_status'] != 'running' and time.monotonic() < deadline:
            time.sleep(.05)
        time.sleep(.4)
        os.kill(real_pid, signal.SIGTERM)
        parent.wait(timeout=5)
        time.sleep(4.2)
        assert not marker.exists()
        store.mark_interrupted()
        assert store.claim_next('recovery') is None
        assert store.get_run(run_id)['model_calls'] == 0
    finally:
        if parent.poll() is None:
            os.kill(real_pid, signal.SIGTERM)
            parent.wait(timeout=5)


def test_generation_export_requires_business_usage_evidence(tmp_path):
    store, run_id = completed_record(tmp_path)
    store.set_run_fields(run_id, model_calls=100, model_evidence_json=dumps({'verified': False, 'events': [{'model_name': 'unverified'}]}))
    _, payload = export_payload(snapshot(store, run_id))
    assert 'generation' not in dumps(payload)
    store.set_run_fields(run_id, model_calls=1, model_evidence_json=dumps({'verified': True, 'events': [{'model_name': 'contract-model', 'usage_status': 'provider_reported', 'prompt_tokens': 12, 'completion_tokens': 3, 'status': 'success'}]}))
    _, payload = export_payload(snapshot(store, run_id))
    assert 'generation' in dumps(payload) and 'capture_time_only' in dumps(payload)
