from copy import deepcopy
from dataclasses import replace
import json
from pathlib import Path
import subprocess

import httpx
import pytest
from fastapi.testclient import TestClient

from agent_evo.api import create_app
from agent_evo.config import Settings
from agent_evo.reporting import answer_unit, metrics, ai_material, validate_report, clean, REPORT_SYSTEM
from agent_evo.report_api import generate


def record(identifier='answer_1', scores=(4, 5, 3, 4), reference=True):
    return {'record_id': identifier, 'turns': [
        {'turn': 1, 'question': '我最近睡眠不佳，如何整理就诊信息？', 'answer': '先整理持续时间与影响。', 'reference': '整理持续时间。' if reference else ''},
        {'turn': 2, 'question': '我更正一下，是三天。', 'answer': '已更正为三天。', 'reference': '采用三天。' if reference else ''}],
        'source': {'filename': 'synthetic.json', 'sha256': 'abc'}, 'assessments': [{'assessment_id': 'a1', 'status': 'completed', 'result': {'quality': 'pass', 'turns': [
            {'turn': t, 'dimensions': [{'dimension': k, 'score': v, 'reason': '测试断言'} for k, v in zip(['factual', 'coverage', 'relevance', 'context'], scores)]} for t in (1, 2)]}}]}


def snap(units):
    return {'version': 'evo-report-v1', 'units': units, 'metrics': metrics(units)}


def report():
    item = {'text': '当前材料存在完整性限制，建议人工复核。', 'metric_refs': ['planned'], 'evidence': []}
    return {'summary': [item], 'strengths': [], 'issues': [], 'recommendations': [], 'limitations': [deepcopy(item)]}


def test_known_score_and_missing_data():
    r = record()
    assert metrics([answer_unit(r)])['score'] == 80
    r['turns'][0]['reference'] = ''
    value = metrics([answer_unit(r)])
    assert value['score'] is None and value['pass_rate'] is None and value['scored'] == 0
    r = record()
    r['assessments'].insert(0, {'assessment_id': 'a2', 'status': 'failed', 'result': {}})
    assert metrics([answer_unit(r)])['score'] is None
    assert answer_unit(r)['assessment_id'] == 'a2'
    r = record()
    r['turns'] = r['turns'][:1]
    r['assessments'][0]['result']['turns'][0]['dimensions'][-1]['score'] = None
    assert metrics([answer_unit(r)])['score'] == 80  # Single-turn context is N/A.
    assert metrics([])['score'] is None and metrics([])['pass_rate'] is None


def test_macro_weighting_critical_and_retries():
    units = [answer_unit(record(str(i), (v, v, v, v))) for i, v in enumerate([5, 5, 5, 1])]
    for i, u in enumerate(units):
        u.update(question_key='q1' if i < 3 else 'q2', repeat_eligible=True, execution='completed')
    units[0]['critical'] = [{'kind': 'rule', 'reason': '关键断言失败'}]
    units[0]['quality'] = 'fail'
    m = metrics(units, 3)
    assert m['score'] == 60 and m['critical']['rule'] == 1 and m['stability'] is None
    assert metrics(units[:3], 3)['stability'] == 0
    retry = deepcopy(units[3]); retry['retry'] = True
    assert metrics(units + [retry], 3)['score'] == 60
    units[0]['dimensions']['context'] = None
    m = metrics(units, 3)
    assert m['score'] is None and m['scored'] == 3 and m['partial_score'] == 60


def test_early_turn_error_and_segmentation_unknown():
    r = record()
    r['assessments'][0]['result']['turns'][0]['dimensions'][0]['score'] = 0
    u = answer_unit(r)
    assert u['low_turns'][0]['turn'] == 1
    r['assessments'][0]['result']['turns'][1]['dimensions'][-1]['score'] = None
    assert metrics([answer_unit(r)])['score'] is None


def test_citations_and_injected_data():
    s = snap([answer_unit(record())]); material = ai_material(s)
    value = report()
    assert validate_report(value, material) == value
    evidence = {'record_id': 'answer_1', 'ref': 'turn:2:assistant', 'quote': '已更正为三天'}
    value['issues'] = [{'text': '需复核更正是否保留。', 'metric_refs': [], 'evidence': [evidence]}]
    validate_report(value, material)
    for field, invalid in [('record_id', 'another_record'), ('quote', '已更正为两周'), ('ref', 'turn:7:assistant')]:
        broken = deepcopy(value); broken['issues'][0]['evidence'][0][field] = invalid
        with pytest.raises(ValueError): validate_report(broken, material)
    broken = deepcopy(value); broken['summary'][0]['text'] = '得分为99，可安全上线'
    with pytest.raises(ValueError): validate_report(broken, material)
    assert clean({'api_key': 'secret', 'answer': 'sk-abcdefghijklmnop'}) == {'answer': '[凭证已移除]'}
    assert '不可信数据' in REPORT_SYSTEM
    assert json.loads(Path('src/agent_evo/report_policy.json').read_text(encoding='utf-8'))['system'] == REPORT_SYSTEM


def test_python_browser_parity(tmp_path):
    records = [record(), record('missing', reference=False), record('low', (0, 5, 4, 3))]
    fixture = tmp_path / 'records.json'; fixture.write_text(json.dumps(records, ensure_ascii=False), encoding='utf-8')
    js = "import fs from 'node:fs';import {reportAnswerUnit,reportMetrics} from './web/src/reportCore.mjs';const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const units=r.map(reportAnswerUnit);process.stdout.write(JSON.stringify({units,metrics:reportMetrics(units)}));"
    actual = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', js, str(fixture)], text=True, encoding='utf-8'))
    units = [answer_unit(r) for r in records]
    assert actual == {'units': units, 'metrics': metrics(units)}


def test_quota_stop_and_repair_limit(monkeypatch):
    calls = []
    def response(*args, **kwargs):
        calls.append(kwargs)
        return httpx.Response(403, json={'error': {'code': 'AllocationQuota.FreeTierOnly'}})
    monkeypatch.setattr(httpx, 'post', response)
    result = generate(ai_material(snap([answer_unit(record())])), 'test-secret', 'qwen3.8-max-0902')
    assert len(calls) == 1 and result['status'] == 'failed' and result['error_code'] == 'AllocationQuota.FreeTierOnly'
    assert result['business_calls'] == 0
    monkeypatch.setattr(httpx, 'post', lambda *a, **kw: httpx.Response(200, json={'id': 'request-1', 'usage': {'total_tokens': 100}, 'choices': [{'message': {'content': '{}'}}]}))
    result = generate(ai_material(snap([answer_unit(record())])), 'test-secret', 'qwen3.8-max-0902')
    assert result['status'] == 'failed' and len(result['usage']) == 2


def test_report_repair_receives_rejected_answer_and_exact_ref(monkeypatch):
    material = ai_material(snap([answer_unit(record())]))
    bad = report()
    bad['issues'] = [{'text': '需要复核更正内容。', 'metric_refs': [], 'evidence': [
        {'record_id': 'answer_1', 'ref': 'turn:9:assistant', 'quote': '不存在的证据'}]}]
    calls = []
    def response(*args, **kwargs):
        calls.append(deepcopy(kwargs['json']))
        return httpx.Response(200, json={'choices': [{'message': {
            'content': json.dumps(bad if len(calls) == 1 else report(), ensure_ascii=False)}}]})
    monkeypatch.setattr(httpx, 'post', response)
    result = generate(material, 'test-secret', 'qwen3.8-max-0902')
    assert result['status'] == 'completed' and len(calls) == 2
    assert json.loads(calls[1]['messages'][2]['content']) == bad
    assert 'turn:9:assistant' in calls[1]['messages'][3]['content']
    assert result['business_calls'] == 0


def test_api_snapshot_dedup_stale_and_immutable(tmp_path, monkeypatch):
    monkeypatch.delenv('DASHSCOPE_API_KEY', raising=False)
    app = create_app(replace(Settings.from_env(), db_path=tmp_path/'db.sqlite', artifact_root=tmp_path/'artifacts', access_token=''), start_worker=False)
    worker = app.state.report_worker
    client = TestClient(app, headers={'X-EVO-Reports': '1', 'X-EVO-Answers': '1'})
    imported = client.post('/api/answers/imports', files={'file': ('example.json', json.dumps([{'question': '我想整理睡眠情况', 'answer': '记录持续时间', 'reference': '记录时间'}]).encode())}).json()
    saved = client.post('/api/answers/imports/'+imported['import_id']+'/commit', json={'name': '合成工程问答', 'mapping': imported['mapping'], 'reviewed_deidentified': True}).json()
    path = '/api/reports/answers/' + saved['batch_id']
    before = client.get(path).json()['snapshot']
    client.post('/api/reports/config', json={'api_key': 'test-only-secret', 'model': 'qwen3.8-max-0902'})
    one = client.post(path, json={}).json()
    assert one == client.post(path, json={}).json()
    assert client.post(path, headers={'Origin': 'https://untrusted.example'}, json={}).status_code == 403
    assert 'test-only-secret' not in client.get(path).text
    monkeypatch.setattr(httpx, 'post', lambda *a, **kw: httpx.Response(200, json={'id': 'report-request', 'usage': {'total_tokens': 300}, 'choices': [{'message': {'content': json.dumps(report())}}]}))
    worker.run_one()
    completed = client.get(path).json()
    assert completed['reports'][0]['status'] == 'completed'
    assert completed['snapshot'] == before
    with app.state.store.connect() as db:
        db.execute("INSERT INTO answer_assessments VALUES('later',?,'failed','now',NULL,'{}')", (before['units'][0]['id'],))
    after = client.get(path).json()
    assert after['reports'][0]['stale'] is True
    assert client.get('/api/reports/saved/'+one['report_id']+'/snapshot').json() == before
    # A failed latest assessment is never replaced with an older successful one.
    assert after['snapshot']['units'][0]['assessment_id'] == 'later'

    paused = worker.save_blocked(after['snapshot'], 'qwen3.8-max-0902', '上游拒绝，未请求报告模型', 'upstream_403')
    assert paused == worker.save_blocked(after['snapshot'], 'qwen3.8-max-0902', '上游拒绝，未请求报告模型', 'upstream_403')
    blocked = next(r for r in client.get(path).json()['reports'] if r['report_id'] == paused)
    assert blocked['status'] == 'failed' and blocked['result']['error_stage'] == 'preflight'
    assert blocked['result']['usage'] == [] and 'report' not in blocked['result']
