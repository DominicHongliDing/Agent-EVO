from dataclasses import replace
import hashlib
import importlib.util
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from agent_evo.config import Settings
from agent_evo.store import Store
from agent_evo.recordings import RecordingInput, import_recording, assert_replayable
from agent_evo.runner import execute_one
from agent_evo.api import create_app


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv('EVO_CONTEXT_JUDGE_ENABLED', '0')
    return Store(replace(Settings.from_env(), db_path=tmp_path / 'evo.db', artifact_root=tmp_path / 'artifacts'))


def recording(count=3, **changes):
    turns = [{'turn_index': i, 'message': f'目前人数{i * 10}人，请记住当前安排。', 'request_message_id': f'user_{i}', 'response_message_id': f'answer_{i}',
              'conversation_id': 'conversation_fixture', 'status': 'completed', 'session_verified': True, 'business_run_id': f'biz_{i}',
              'model_calls': 1, 'model_evidence': {'calls': 1, 'verified': True}, 'output': {'result': {'answer': f'记录为{i * 10}人。'}},
              'events': [{'kind': 'business_step', 'node': 'intent', 'status': 'completed', 'payload': {'summary': '已识别安排'}}]} for i in range(1, count + 1)]
    return RecordingInput.model_validate({'protocol': 'agent-evo-recording-v1', 'agent_id': 'agent_unihr', 'source_scope': hashlib.sha256(b'synthetic').hexdigest(),
                  'conversation_id': 'conversation_fixture', 'title': '人员安排', 'data_classification': 'synthetic', 'privacy_confirmed': True, 'turns': turns, **changes})


def test_recording_never_invokes_business_and_excludes_live_counts(store, monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('recorded mode must not execute a business agent')
    monkeypatch.setattr('agent_evo.runner.run_unihr', forbidden)
    item = import_recording(store, recording())
    claimed = store.claim_next('test')
    execute_one(claimed, store, store.settings)
    run = store.get_run(item['run_id'])
    assert run['status'] == 'completed'
    assert run['model_calls'] == 3
    assert run['output']['new_business_calls'] == 0
    assert store.get_batch(run['batch_id'])['live_model_verified'] == 0
    assert len([v for v in store.verdicts(run['run_id']) if v['dimension'] == 'context_session']) == 3
    assert any(e['node'] == 'intent' and e['payload']['turn_index'] == 2 for e in store.events(run['run_id']))


def test_deduplication_and_later_snapshot_does_not_mutate_prior(store):
    a = import_recording(store, recording(2))
    assert import_recording(store, recording(2)) == {'run_id': a['run_id'], 'deduplicated': True}
    b = import_recording(store, recording(3))
    assert b['run_id'] != a['run_id']
    assert len(store.get_run(a['run_id'])['output']['conversation_turns']) == 2


def test_evaluator_error_keeps_immutable_native_snapshot(store, monkeypatch):
    item = import_recording(store, recording())
    before = store.get_run(item['run_id'])['output']
    def broken(*args):
        raise RuntimeError('scoring fixture failure')
    monkeypatch.setattr('agent_evo.runner.evaluate_run', broken)
    execute_one(store.claim_next('test'), store, store.settings)
    run = store.get_run(item['run_id'])
    assert run['output'] == before
    assert run['error_code'] == 'recording_evaluator_error'
    assert store.events(item['run_id'])[-1]['payload']['native_snapshot_preserved'] is True


def test_sensitive_fields_redacted_before_persistence(store):
    payload = recording(1)
    payload.turns[0].output = {'result': {'answer': '联系方式 13800138000 demo@example.com', 'api_key': 'never-persist', 'local_path': 'private/path'}}
    item = import_recording(store, payload)
    raw = store.get_run(item['run_id'])['output']['conversation_turns'][0]['output']['result']
    assert raw == {'answer': '联系方式 [已脱敏] [已脱敏]'}


def test_replay_creates_live_run_and_keeps_prior_evidence(store):
    item = import_recording(store, recording())
    store.set_run_fields(item['run_id'], status='completed')
    before = store.get_run(item['run_id'])
    retry = store.retry(item['run_id'])
    assert retry['execution_mode'] == 'live' and retry['retry_of'] == item['run_id']
    assert retry['model_calls'] == 0
    assert store.get_run(item['run_id']) == before


def test_missing_attachments_and_long_recording_block_all_replay_routes(store):
    item = import_recording(store, recording(requires_attachments=True))
    store.set_run_fields(item['run_id'], status='completed')
    with pytest.raises(ValueError, match='附件'):
        store.retry(item['run_id'])
    with pytest.raises(ValueError, match='附件'):
        store.retry_selected(item['batch_id'], [item['run_id']])
    long = import_recording(store, recording(13))
    with pytest.raises(ValueError, match='12 轮'):
        store.create_batch([store.get_run(long['run_id'])['case_id']], 'retry')


def test_contract_requires_classification_and_message_binding():
    raw = recording().model_dump()
    raw['privacy_confirmed'] = False
    with pytest.raises(ValueError):
        RecordingInput.model_validate(raw)
    raw = recording().model_dump()
    raw['turns'][1]['request_message_id'] = raw['turns'][0]['request_message_id']
    with pytest.raises(ValueError, match='重复'):
        RecordingInput.model_validate(raw)


def test_recording_token_does_not_grant_admin_access(store, monkeypatch):
    monkeypatch.setenv('EVO_RECORDING_TOKEN', 'scoped-fixture-token')
    app = create_app(replace(store.settings, access_token='admin-fixture-token'), start_worker=False)
    with TestClient(app) as client:
        assert client.post('/api/recordings', json=recording().model_dump()).status_code == 401
        assert client.post('/api/recordings', json=recording(agent_id='agent_clinical').model_dump(), headers={'X-EVO-Recording-Token': 'scoped-fixture-token'}).status_code == 201
        assert client.post('/api/recordings', json=recording().model_dump(), headers={'X-EVO-Recording-Token': 'scoped-fixture-token'}).status_code == 403
        assert client.get('/api/runs', headers={'X-EVO-Recording-Token': 'scoped-fixture-token'}).status_code == 401


def test_source_preview_detects_change_and_selected_prefix_keeps_history():
    spec = importlib.util.spec_from_file_location('bridge_fixture', Path(__file__).parents[1] / 'integrations/evo_bridge.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    raw = recording().model_dump()
    preview = module.prepare(raw, module.BridgeRequest(data_classification='synthetic'))
    selected = module.prepare(recording().model_dump(), module.BridgeRequest(data_classification='synthetic', end_turn=2, expected_sha256=preview['preview_sha256']))
    assert len(selected['turns']) == 2 and selected['turns'][0]['turn_index'] == 1
    changed = recording().model_dump()
    changed['turns'][0]['message'] += '补充'
    with pytest.raises(HTTPException) as exc:
        module.prepare(changed, module.BridgeRequest(data_classification='synthetic', expected_sha256=preview['preview_sha256']))
    assert exc.value.status_code == 409
