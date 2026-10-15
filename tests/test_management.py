from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from agent_evo.api import create_app
from agent_evo.config import Settings
from agent_evo.models import DatasetInput
from agent_evo.management import preview_dataset
from agent_evo.store import Store, dumps, now
from agent_evo.runner import execute_one
from agent_evo import generic_adapter


@pytest.fixture
def store(tmp_path: Path):
    return Store(replace(Settings.from_env(), db_path=tmp_path / 'test.db', artifact_root=tmp_path / 'artifacts'))


def dataset_input(**changes):
    values = dict(name='合成通用集', profile='generic', filename='synthetic.jsonl', content=json.dumps({'case_id':'same_source_id','message':'请帮我整理需要准备的材料清单','expected':{'output_contains':['合成回答']}}, ensure_ascii=False))
    return DatasetInput(**{**values, **changes})


def generic_setup(store):
    target = store.save_agent(dict(name='合成测试 Agent', adapter_kind='http_json', base_url='http://127.0.0.1:8010'))
    dataset = store.import_dataset(dataset_input())
    store.assign_datasets(target['agent_id'], [dataset['dataset_id']])
    case = store.list_cases(dataset_id=dataset['dataset_id'])[0]
    return target, dataset, case


def create_run(store):
    a, d, c = generic_setup(store)
    b = store.create_batch([c['case_id']], '合同测试', a['agent_id'], d['dataset_id'])
    return a, d, c, b, b['runs'][0]['run_id']


def test_migration_is_repeatable_and_freezes_existing_evidence(store):
    case = store.list_cases()[0]
    b = store.create_batch([case['case_id']], 'legacy')
    run_id = b['runs'][0]['run_id']
    store.set_run_fields(run_id, status='completed', output_json=dumps({'result':{'answer':'合成原文'}}), model_calls=3, model_evidence_json=dumps({'verified':True}), finished_at=now())
    store.add_event(run_id, 'business_step','source','completed',{'summary':'合成证据'})
    before = store.get_run(run_id); events = store.events(run_id)
    for _ in range(2):
        current = Store(store.settings)
        assert len(current.list_cases()) == 100
        assert len(current.list_agents()) == 2
        assert len(current.list_datasets()) == 2
        assert current.get_run(run_id) == before
        assert current.events(run_id) == events


def test_jsonl_reports_bad_line_and_import_is_atomic(store):
    good = dataset_input().content
    payload = dataset_input(content=good+'\n{broken}\n')
    preview = preview_dataset(payload, store.settings.fixture_root)
    assert not preview['valid'] and preview['errors'][0]['line'] == 2
    before = (len(store.list_cases()),len(store.list_datasets()))
    with pytest.raises(ValueError): store.import_dataset(payload)
    assert (len(store.list_cases()),len(store.list_datasets())) == before


def test_duplicate_upload_source_ids_never_overwrite_frozen_cases(store):
    first = store.import_dataset(dataset_input()); second = store.import_dataset(dataset_input())
    a=store.list_cases(dataset_id=first['dataset_id'])[0]; b=store.list_cases(dataset_id=second['dataset_id'])[0]
    assert a['source_case_id'] == b['source_case_id']
    assert a['case_id'] != b['case_id'] and first['dataset_id'] != second['dataset_id']
    assert first['content_sha256'] == second['content_sha256']
    invalid=dataset_input(content=dataset_input().content+'\n'+dataset_input().content)
    assert any('重复' in e['message'] for e in preview_dataset(invalid,store.settings.fixture_root)['errors'])


@pytest.mark.parametrize('row', [
    {'message':'联系 13800138000'}, {'message':'合成问题','api_key':'synthetic-key'},
    {'message':'合成问题','expected':{'access_token':'synthetic-token'}},
    {'message':'合成问题','gold_status':'clinician_approved'},
    {'message':'合成问题','fixtures':['../../unsafe.json']},
])
def test_upload_rejects_sensitive_or_false_approval_fields(store,row):
    parsed=preview_dataset(dataset_input(content=json.dumps(row)),store.settings.fixture_root)
    assert not parsed['valid']
    assert '13800138000' not in json.dumps(parsed['errors'])


def test_csv_and_json_import_contracts(store):
    csv=dataset_input(filename='test.csv',content='case_id,title,message\ncsv01,合成标题,合成输入\n')
    assert preview_dataset(csv,store.settings.fixture_root)['valid']
    js=dataset_input(filename='test.json',content=json.dumps({'cases':[{'input':'合成输入'}]}))
    assert preview_dataset(js,store.settings.fixture_root)['valid']


def test_assignment_enforces_profile_and_explicit_target(store):
    agent,ds,case=generic_setup(store)
    original=[d for d in store.list_agents() if d['agent_id']==agent['agent_id']][0]['dataset_ids']
    clinical=next(d for d in store.list_datasets() if d['profile']=='clinical')
    with pytest.raises(ValueError): store.assign_datasets(agent['agent_id'],[clinical['dataset_id']])
    assert next(d for d in store.list_agents() if d['agent_id']==agent['agent_id'])['dataset_ids'] == original
    with pytest.raises(ValueError): store.create_batch([case['case_id']],'bad','agent_clinical',ds['dataset_id'])
    store.assign_datasets(agent['agent_id'],[])
    with pytest.raises(ValueError): store.create_batch([case['case_id']],'bad',agent['agent_id'],ds['dataset_id'])


def test_delete_is_atomic_and_preserves_completed_history(store):
    _,_,_,a,run_a=create_run(store); _,_,_,b,run_b=create_run(store)
    store.set_run_fields(run_a,status='completed',output_json=dumps({'result':{'answer':'合成原文'}}),finished_at=now())
    store.add_event(run_a,'business_trace','node','completed',{'summary':'合成证据'})
    before=store.get_run(run_a); evidence=store.events(run_a)
    with pytest.raises(ValueError): store.manage_batches([a['batch_id'],b['batch_id']],'delete')
    assert not store.get_batch(a['batch_id'])['deleted_at']
    assert not store.get_batch(b['batch_id'])['deleted_at']
    store.manage_batches([a['batch_id']],'pin')
    assert Store(store.settings).list_batches()[0]['batch_id']==a['batch_id']
    store.manage_batches([a['batch_id']],'delete')
    assert a['batch_id'] not in [v['batch_id'] for v in store.list_batches()]
    store.manage_batches([a['batch_id']],'restore')
    assert store.get_run(run_a)==before and store.events(run_a)==evidence
    assert store.get_run(run_b)['status']=='queued'


def test_agent_and_dataset_delete_guards_active_references(store):
    agent,ds,_,_,run_id=create_run(store)
    for kind,identifier in [('agent',agent['agent_id']),('dataset',ds['dataset_id'])]:
        with pytest.raises(ValueError): store.change_entity_state(kind,identifier)
    store.set_run_fields(run_id,status='failed',finished_at=now())
    store.change_entity_state('dataset',ds['dataset_id'])
    assert store.get_case(store.get_run(run_id)['case_id'])['message']=='请帮我整理需要准备的材料清单'
    store.change_entity_state('dataset',ds['dataset_id'],True)


def test_failure_list_deduplicates_runs_and_excludes_unjudged(store):
    _,_,_,batch,run_id=create_run(store)
    store.set_run_fields(run_id,status='completed',finished_at=now())
    store.add_verdict(run_id,'intent','deterministic-v1','fail','意图偏差',['event:1'])
    store.add_verdict(run_id,'retrieval','deterministic-v1','fail','无材料',['event:2'])
    store.add_verdict(run_id,'critical_safety','deterministic-v1','unjudged','待复核',[])
    assert store.failures(batch['batch_id'])['total']==1
    assert store.failures(batch['batch_id'])['assertion_count']==2
    assert store.failures(batch['batch_id'],'retrieval')['assertion_count']==1
    assert len(store.failures(batch['batch_id'],'retrieval')['items'][0]['findings'])==1
    assert not store.failures(batch['batch_id'],critical=True)['items']
    store.add_verdict(run_id,'critical_safety','deterministic-v1','fail','安全失败',[],True)
    assert store.failures(batch['batch_id'],critical=True)['total']==1
    assert store.failures(batch['batch_id'],'retrieval',critical=True)['total']==0


def test_retries_freeze_original_target_and_preserve_baseline(store):
    a,_,_,batch,run_id=create_run(store)
    store.set_run_fields(run_id,status='failed',finished_at=now())
    original=store.get_run(run_id)
    store.save_agent({**a,'base_url':'http://127.0.0.1:8020'},a['agent_id'])
    new=store.retry_selected(batch['batch_id'],[run_id]); retry=store.get_run(new['runs'][0]['run_id'])
    assert retry['batch_id'] != batch['batch_id'] and retry['retry_of']==run_id
    assert retry['agent_snapshot']==original['agent_snapshot']
    assert retry['agent_snapshot']['base_url']=='http://127.0.0.1:8010'
    assert store.get_run(run_id)==original


@pytest.mark.parametrize('with_usage',[False,True])
def test_generic_entry_is_called_but_bare_counts_are_not_model_proof(store,monkeypatch,with_usage):
    _,_,case,_,run_id=create_run(store)
    seen=[]
    def handle(request):
        body=json.loads(request.content); seen.append(body)
        assert 'expected' not in body and body['message']==case['message']
        assert request.url.path=='/evaluate'
        usage={'events':[{'run_id':'business01','provider':'dashscope','model_name':'synthetic-contract-model','status':'success','usage_status':'provider_reported','prompt_tokens':1,'completion_tokens':2}]} if with_usage else {'calls':999,'verified':True}
        return httpx.Response(200,json={'business_status':'succeeded','business_run_id':'business01','result':{'answer':'合成回答'},'events':[{'node':'model.answer','status':'completed','summary':'合同测试节点'}],'model_usage':usage})
    monkeypatch.setattr(generic_adapter,'_client',lambda base,timeout:httpx.Client(base_url=base,transport=httpx.MockTransport(handle)))
    execute_one(store.get_run(run_id),store,store.settings)
    run=store.get_run(run_id)
    assert len(seen)==1 and run['status']=='completed'
    assert run['model_calls']==int(with_usage) and run['model_evidence']['verified']==with_usage
    assert any(e['node']=='agent.http.response' for e in store.events(run_id))
    assert any(e['node']=='model.answer' for e in store.events(run_id))


def test_management_api_error_status_and_history(store):
    app=create_app(store.settings,start_worker=False)
    with TestClient(app) as client:
        assert len(client.get('/api/agents').json()['items'])==1
        bad=client.post('/api/agents',json={'name':'bad','adapter_kind':'http_json','base_url':'http://example.com'})
        assert bad.status_code==403
        c = store.list_cases('clinical')[0]
        ds = {'dataset_id': c['dataset_id']}
        b = store.create_batch([c['case_id']], 'Clinical 合同测试', 'agent_clinical', c['dataset_id'])
        run_id = b['runs'][0]['run_id']
        conflict=client.post('/api/batches/manage',json={'batch_ids':[b['batch_id']],'action':'delete'})
        assert conflict.status_code==409
        assert client.get('/api/runs/'+run_id).json()['case']['dataset_id']==ds['dataset_id']
        assert client.get('/api/batches/'+b['batch_id']+'/failures').status_code==200


@pytest.mark.parametrize('json_response', [True, False])
def test_failed_http_response_preserves_evidence_without_credentials(store, monkeypatch, json_response):
    agent, dataset, case = generic_setup(store)
    store.save_agent({**agent, 'credential_env_prefix': 'SYNTHETIC_CONTRACT'}, agent['agent_id'])
    batch = store.create_batch([case['case_id']], '故障合同测试', agent['agent_id'], dataset['dataset_id'])
    run_id = batch['runs'][0]['run_id']
    monkeypatch.setenv('SYNTHETIC_CONTRACT_ACCESS_TOKEN', 'synthetic-contract-token')
    def handle(request):
        if json_response:
            return httpx.Response(503, json={'error': '节点故障', 'authorization': 'synthetic-contract-token'})
        return httpx.Response(502, text='节点故障 synthetic-contract-token')
    monkeypatch.setattr(generic_adapter, '_client', lambda base, timeout: httpx.Client(base_url=base, transport=httpx.MockTransport(handle)))
    execute_one(store.get_run(run_id), store, store.settings)
    events = store.events(run_id)
    response = next(e for e in events if e['node'] == 'agent.http.response')
    assert response['status'] == 'failed' and response['payload']['http_status'] in {502, 503}
    assert 'synthetic-contract-token' not in dumps(events)
    assert '[redacted]' in dumps(response)
    assert store.get_run(run_id)['status'] == 'failed'
