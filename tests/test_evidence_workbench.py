from dataclasses import replace
import json
from pathlib import Path

import pytest
import httpx
from fastapi.testclient import TestClient

from agent_evo.api import create_app
from agent_evo.config import Settings
from agent_evo.store import Store, dumps
from agent_evo.evaluation import evaluate_run
from agent_evo.evidence import stability, summary, trace_detail, trace_search, import_model_evidence
from agent_evo.assessment import validate_quality, validate_diagnosis, DIMENSIONS, assess


def test_clinical_projection_matches_business_display_without_rewriting():
    from copy import deepcopy
    from agent_evo.conversation import answer_text
    from agent_evo.evidence import observations
    output = {'result': {'answer': {'summary': '回答。回答。', 'sections': [
        {'title': '模型输出', 'content': '回答。回答。'}, {'title': '核对', 'content': '请核对。'}]},
        'citations': [{'source_id': 'source-a', 'evidence_snippet': '已保存的来源片段…'}]}}
    before = deepcopy(output)
    assert answer_text(output) == '回答。回答。\n请核对。'
    rows = observations({'status': 'completed', 'output': output})
    source = next(r for r in rows if r['kind'] == 'retrieval_evidence')
    assert source['coverage'] == 'partial' and source['id'] == 'turn:1:source:1'
    assert output == before


def test_partial_source_does_not_become_fact_failure_or_single_turn_context_score():
    from agent_evo.assessment import quality_eligibility
    r = {'status': 'completed', 'case': {'message': '请整理信息', 'expected': {'must_retrieve': True}},
         'output': {'result': {'answer': '请补充信息。', 'citations': [
             {'evidence_snippet': '部分原文…'}]}}}
    assert set(quality_eligibility(r)) == {'context', 'evidence_consistency'}
    proposed = {'dimensions': [{'dimension': d, 'score': 2, 'reason': '模型建议',
         'evidence': [{'ref': 'turn:1:assistant', 'quote': '请补充信息'}]} for d in DIMENSIONS]}
    result = validate_quality(proposed, r)
    values = {d['dimension']: d for d in result['dimensions']}
    assert values['evidence_consistency']['score'] is None
    assert values['evidence_consistency']['unaccepted_proposal']['score'] == 2
    assert values['coverage']['score'] == 2 and result['total_score'] is None


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.delenv('DASHSCOPE_API_KEY', raising=False)
    monkeypatch.setenv('EVO_CONTEXT_JUDGE_ENABLED', '0')
    return create_app(replace(Settings.from_env(), db_path=tmp_path/'evo.db', artifact_root=tmp_path/'artifacts', access_token=''), start_worker=False)


def make_run(store, repetitions=1):
    case = store.list_cases('clinical')[0]
    batch = store.create_batch([case['case_id']], '证据检查', repetitions=repetitions)
    run = store.get_run(batch['runs'][0]['run_id'])
    store.set_run_fields(run['run_id'], status='completed', output_json=dumps({'result': {'answer': '仍按两周整理。'}}))
    return run['run_id'], batch


def full(store, rid):
    r = store.get_run(rid)
    return {**r, 'case': store.get_case(r['case_id']), 'events': store.events(rid), 'verdicts': store.verdicts(rid)}


def test_50_cases_five_independent_repeats_and_legacy_default(app):
    store = app.state.store
    cases = store.list_cases('clinical')[:50]
    with TestClient(app) as client:
        response = client.post('/api/batches', json={'case_ids': [c['case_id'] for c in cases], 'repetitions': 5})
        assert response.status_code == 201
        batch = response.json()
        assert batch['total'] == 250 and batch['repetitions'] == 5
        assert len({r['run_id'] for r in batch['runs']}) == 250
        assert {r['repetition_index'] for r in batch['runs'][:5]} == {1,2,3,4,5}
        assert client.post('/api/batches',json={'case_ids':[cases[0]['case_id']], 'repetitions': 6}).status_code == 422
    legacy = store.create_batch([cases[0]['case_id']], 'legacy')
    assert legacy['repetitions'] == 1 and legacy['total'] == 1


def test_stability_partial_denominators_and_retries(app):
    store = app.state.store
    rid, batch = make_run(store, 5)
    for row in batch['runs'][:4]:
        store.set_run_fields(row['run_id'], status='completed')
        store.add_verdict(row['run_id'], 'answer', 'manual-fixture', 'pass', '满足要求', [])
    failed = batch['runs'][4]['run_id']
    store.set_run_fields(failed, status='failed', error_code='ConnectError')
    r = stability(store, store.get_batch(batch['batch_id']))
    assert (r['judged'],r['planned'],r['coverage']) == (4,5,.8)
    assert r['macro_pass_rate'] == 1 and r['complete_cases'] == 0 and r['all_pass_rate'] is None
    assert summary(full(store,failed))['quality'] == 'unjudged'
    store.retry(failed)
    assert stability(store,store.get_batch(batch['batch_id']))['planned'] == 5


def test_environment_failure_not_answer_error_and_priority_not_root(app):
    store=app.state.store;rid,_=make_run(store)
    store.set_run_fields(rid,status='failed',error_code='ConnectError')
    result=evaluate_run(store,rid)
    assert next(f for f in result['findings'] if f['dimension']=='business_execution')['status']=='unjudged'
    assert result['root_cause_status']=='unconfirmed'
    assert result['first_failure_semantics']=='priority_issue_not_chronological_root'


def test_failed_model_call_can_be_inspected_and_first_value_not_root(app):
    store=app.state.store;rid,_=make_run(store)
    store.add_event(rid,'model_call','answer','failed',{'call_id':'call-failed','coverage':'full','request':{'messages':[{'role':'user','content':'是三天，不是两周。'}]},'response':None,'error_type':'ReadTimeout'})
    item=full(store,rid)
    ref='event:'+str(item['events'][-1]['seq'])
    assert trace_detail(item,ref)['data']['response'] is None
    found=trace_search(item,'两周')
    assert found['total']>=1 and '不能直接判定根因' in found['note']
    assert summary(item)['root_cause_status']=='unconfirmed'
    with pytest.raises(KeyError):trace_detail(item,'event:999999')


def test_import_capture_once_uses_actual_source_and_preserves_coverage(app,tmp_path):
    store=app.state.store;rid,_=make_run(store)
    root=tmp_path/'.local'/'evo-evidence';root.mkdir(parents=True)
    row={'business_run_id':'biz_1','call_id':'call-1','synthetic':True,'coverage':'full','node':'answer','status':'success','request':{'messages':[{'content':'三天'}]},'response':{'content':'三天'}}
    (root/'biz_1.jsonl').write_text(dumps(row)+'\n',encoding='utf-8')
    import_model_evidence(store,rid,tmp_path,'biz_1');import_model_evidence(store,rid,tmp_path,'biz_1')
    assert len([e for e in store.events(rid) if e['kind']=='model_call'])==1
    import_model_evidence(store,rid,tmp_path,'../biz_1')
    assert len(store.events(rid))==1


def test_source_all_and_groups_not_any_match(app):
    store=app.state.store
    from agent_evo.models import DatasetInput
    payload={'case_id':'evidence_groups_case','message':'请整理这两份资料的适用范围。','expected':{'must_retrieve':True,'source_ids':['a','b']}}
    dataset=store.import_dataset(DatasetInput(name='材料覆盖',profile='clinical',version='v1',filename='x.jsonl',content=dumps(payload)))
    case=store.list_cases(dataset_id=dataset['dataset_id'])[0]
    rid=store.create_batch([case['case_id']],'coverage')['runs'][0]['run_id']
    store.set_run_fields(rid,status='completed',output_json=dumps({'result':{'trace':{'needs_retrieval':True,'retrieval_candidate_count':3,'selected_sources':[{'document_id':'a'}]}}}))
    result=evaluate_run(store,rid)
    by={f['dimension']:f for f in result['findings']}
    assert by['retrieval']['status']=='unjudged' and by['retrieval_execution']['status']=='pass'
    assert by['source_selection']['status']=='fail'


def test_source_groups_validated_and_cross_batch_comparison(app):
    from agent_evo.models import EvalCase
    from pydantic import ValidationError
    store=app.state.store
    case=store.list_cases('clinical')[0]
    with pytest.raises(ValidationError):
        EvalCase.model_validate({**case,'expected':{'source_match':'groups','source_groups':['a']}})
    valid=EvalCase.model_validate({**case,'expected':{'source_match':'groups','source_groups':[['a','b'],['c']]}})
    assert valid.expected['source_groups']==[['a','b'],['c']]
    left,_=make_run(store);right,_=make_run(store)
    with TestClient(app) as client:
        rows=client.get('/api/runs',params={'case_id':case['case_id']}).json()['items']
        assert {left,right} <= {r['run_id'] for r in rows}
        comparison=client.get('/api/evidence/compare',params={'left':left,'right':right}).json()
        assert comparison['same_case'] is True
        assert comparison['left']['trace']['items']


def test_regression_is_new_frozen_case_and_hr_queries_blocked(app):
    store=app.state.store;rid,batch=make_run(store)
    before=dumps(full(store,rid)['output'])
    with TestClient(app) as client:
        response=client.post(f'/api/runs/{rid}/regression',json={'name':'更正回归','expectation':'后续回答采用三天'})
        assert response.status_code==201,response.text
        ds=response.json();case=store.list_cases(dataset_id=ds['dataset_id'])[0]
        assert case['expected']['regression_of']==rid and case['gold_status']=='engineering_draft'
        assert case['case_id']!=store.get_run(rid)['case_id']
        assert before==dumps(full(store,rid)['output'])
        assert client.get(f'/api/runs/{rid}/evidence').status_code==200
        hr=store.create_batch([store.list_cases('unihr')[0]['case_id']],'hr')['runs'][0]['run_id']
        assert client.get(f'/api/runs/{hr}/evidence').status_code==404
        assert client.post(f'/api/runs/{hr}/assessments',json={'mode':'diagnosis'}).status_code==404


def test_judge_rejects_fabricated_citation_and_keeps_scoring_separate(app,monkeypatch):
    store=app.state.store;rid,_=make_run(store);run=full(store,rid)
    dimensions=[{'dimension':d,'score':3,'reason':'有可观察偏差','evidence':[{'ref':'turn:1:assistant','quote':'两周'}]} for d in DIMENSIONS]
    result=validate_quality({'dimensions':dimensions},run)
    assert result['total_score'] is None  # Missing source and single-turn context are not scored.
    assert dimensions[1]['score'] == 3
    dimensions[1]['score']=3.5
    with pytest.raises(ValueError):validate_quality({'dimensions':dimensions},run)
    dimensions[1]['score']=3;dimensions[1]['evidence'][0]['quote']='编造证据'
    with pytest.raises(ValueError):validate_quality({'dimensions':dimensions},run)
    before=store.get_run(rid)
    response=assess(store,run,'diagnosis')
    assert response['status']=='unjudged' and response['business_calls']==0
    assert store.get_run(rid)==before
    assert store.events(rid)[-1]['node']=='assessment.result'


def test_read_only_diagnosis_queries_are_recorded_and_validated(app,monkeypatch):
    store=app.state.store;rid,_=make_run(store);run=full(store,rid)
    monkeypatch.setenv('DASHSCOPE_API_KEY','not-a-real-key')
    replies=[{'tool':'detail','ref':'turn:1:assistant'}, {'first_observed':'turn:1:assistant','analysis':'仅能观察到回答内容，缺少模型请求，原因待验证','suggestion':'补充该步实际输入后复核','candidates':[{'category':'unknown','reason':'缺少请求','evidence':[{'ref':'turn:1:assistant','quote':'两周'}]}]}]
    def post(url,**kwargs):
        assert '/chat/completions' in url
        request=httpx.Request('POST',url)
        return httpx.Response(200,request=request,json={'id':'judge-fixture','choices':[{'message':{'content':dumps(replies.pop(0))}}],'usage':{'total_tokens':20}})
    monkeypatch.setattr('agent_evo.assessment.httpx.post',post)
    result=assess(store,run,'diagnosis')
    assert result['status']=='completed' and result['result']['root_cause_status']=='unconfirmed'
    assert len([e for e in store.events(rid) if e['node']=='assessment.query'])==1
    assert len([e for e in store.events(rid) if e['node']=='assessment.usage'])==2
    assert store.get_run(rid)['model_calls']==0
    assert 'not-a-real-key' not in dumps(store.events(rid))


def test_excluded_facts_do_not_leak_into_other_quality_dimensions(app, monkeypatch):
    store = app.state.store
    rid, _ = make_run(store)
    run = full(store, rid)
    run['case'].update(gold_status='engineering_draft', expected={'must_retrieve': True, 'source_ids': ['unreviewed-gold']})
    run['output']['result']['citations'] = [{'evidence_snippet': 'partial-source-marker'}]
    monkeypatch.setenv('DASHSCOPE_API_KEY', 'not-a-real-key')
    def post(url, **kwargs):
        material = json.loads(kwargs['json']['messages'][1]['content'])
        assert 'expectations' not in material
        assert all(r['kind'] == 'conversation' for r in material['records'])
        assert set(material['eligibility_exclusions']) == {'context', 'evidence_consistency'}
        dimensions = [{'dimension': d, 'score': None if d in material['eligibility_exclusions'] else 3,
            'reason': '仅核对可见交付', 'evidence': [{'ref': 'turn:1:assistant', 'quote': '两周'}]} for d in DIMENSIONS]
        return httpx.Response(200, request=httpx.Request('POST', url), json={
            'choices': [{'message': {'content': dumps({'dimensions': dimensions})}}], 'usage': {'total_tokens': 20}})
    monkeypatch.setattr('agent_evo.assessment.httpx.post', post)
    result = assess(store, run, 'quality')
    assert result['status'] == 'completed' and result['rubric']['version'] == 'engineering-rubric-v5'
    assert any(e['node'] == 'assessment.request' for e in store.events(rid))
