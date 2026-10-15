from dataclasses import replace
import io
import json

from fastapi.testclient import TestClient
from openpyxl import Workbook
import httpx
import pytest

from agent_evo.api import create_app
from agent_evo.config import Settings
from agent_evo.answer_imports import parse_file, record_detail
from agent_evo.answer_judge import validate, material, DIMENSIONS

HEADERS = {'X-EVO-Answers': '1'}


@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.delenv('DASHSCOPE_API_KEY', raising=False)
    return create_app(replace(Settings.from_env(), db_path=tmp_path/'evo.db', artifact_root=tmp_path/'artifacts', access_token=''), start_worker=False)


@pytest.fixture
def client(app):
    with TestClient(app, headers=HEADERS) as c:
        yield c


def upload(client, rows, filename='answers.json'):
    content = json.dumps(rows, ensure_ascii=False).encode() if not isinstance(rows, bytes) else rows
    response = client.post('/api/answers/imports', files={'file': (filename, content)})
    assert response.status_code == 201, response.text
    return response.json()


def save(client, file, **options):
    response = client.post(f"/api/answers/imports/{file['import_id']}/commit", json={
        'mapping': file['mapping'], 'reviewed_deidentified': True, 'name': '导入验收', **options})
    assert response.status_code == 201, response.text
    batch = client.get('/api/answers/batches/' + response.json()['batch_id']).json()
    return batch, response.json()['reused']


def score_response(record, score=5):
    return {'summary': '按已有材料检查。', 'critical_findings': [], 'turns': [
        {'turn': t['turn'], 'dimensions': [{'dimension': d, 'score': score, 'reason': '依据本轮原文',
            'evidence': [{'ref': f"turn:{t['turn']}:assistant", 'quote': t['answer'][:30]}]} for d in DIMENSIONS]}
        for t in record['turns']]}


def test_csv_alias_mapping_and_import_never_runs_agent(client, app, monkeypatch):
    monkeypatch.setattr(httpx, 'get', lambda *a, **k: pytest.fail('导入不能检查业务服务'))
    monkeypatch.setattr(httpx, 'post', lambda *a, **k: pytest.fail('保存不能调用模型或 Agent'))
    store = app.state.store
    with store.connect() as db:
        before = db.execute('SELECT COUNT(*) FROM runs').fetchone()[0]
    file = upload(client, '用户问题,Agent 回答\n请确认时间,周四下午\n'.encode(), '表格.csv')
    assert file['mapping']['question'] == '用户问题'
    preview = client.post(f"/api/answers/imports/{file['import_id']}/preview", json={'mapping': file['mapping']}).json()
    assert preview['valid'] and preview['total'] == 1
    assert preview['records'][0]['turns'][0]['line'] == 2
    batch, reused = save(client, file)
    assert not reused and batch['records'][0]['status'] == 'not_started'
    detail = client.get('/api/answers/records/' + batch['records'][0]['record_id']).json()
    assert detail['source']['business_calls'] == 0 and not detail['source']['execution_verified']
    assert detail['original_fields'][0]['value']['Agent 回答'] == '周四下午'
    original = client.get('/api/answers/imports/' + file['import_id'] + '/file')
    assert original.status_code == 200 and original.content.decode() == '用户问题,Agent 回答\n请确认时间,周四下午\n'
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM runs').fetchone()[0] == before


def test_mapping_ambiguity_must_be_resolved(client):
    file = upload(client, [{'question': '问题', 'input': '另一问题', 'answer': '回答'}])
    assert 'question' in file['ambiguous'] and not file['mapping']['question']
    path = f"/api/answers/imports/{file['import_id']}/preview"
    assert not client.post(path, json={'mapping': file['mapping']}).json()['valid']
    mapping = {**file['mapping'], 'question': 'input'}
    assert client.post(path, json={'mapping': mapping}).json()['records'][0]['turns'][0]['question'] == '另一问题'
    assert not client.post(path, json={'mapping': {**mapping, 'question': 'answer'}}).json()['valid']


def test_multiturn_order_and_duplicate_round_validation(client):
    file = upload(client, [{'conversation_id': 'a', 'turn': 2, 'question': '确认一下', 'answer': '周四'},
                           {'conversation_id': 'a', 'turn': 1, 'question': '改到周四', 'answer': '好的'}])
    preview = client.post(f"/api/answers/imports/{file['import_id']}/preview", json={'mapping': file['mapping']}).json()
    assert preview['valid'] and preview['total'] == 1 and preview['turn_count'] == 2
    assert preview['records'][0]['turns'][0]['question'] == '改到周四'
    duplicate = upload(client, [{'conversation_id': 'a', 'turn': 1, 'question': '甲', 'answer': '甲'}, {'conversation_id': 'a', 'turn': 1, 'question': '乙', 'answer': '乙'}])
    p = client.post(f"/api/answers/imports/{duplicate['import_id']}/preview", json={'mapping': duplicate['mapping']}).json()
    assert not p['valid'] and any('重复轮次' in e['message'] for e in p['errors'])
    no_order = upload(client, [{'conversation_id': 'a', 'question': '甲', 'answer': '甲'}, {'conversation_id': 'a', 'question': '乙', 'answer': '乙'}])
    path = f"/api/answers/imports/{no_order['import_id']}/preview"
    assert not client.post(path, json={'mapping': no_order['mapping']}).json()['valid']
    assert client.post(path, json={'mapping': no_order['mapping'], 'confirm_order': True}).json()['turn_count'] == 2


def test_pasted_dialogue_and_nested_json_keep_every_turn(client):
    text = '用户：改成周四下午。\n助手：好的。\n用户：请再次确认。\n助手：周四下午。'
    file = upload(client, text.encode(), 'paste.txt')
    batch, _ = save(client, file)
    detail = client.get('/api/answers/records/' + batch['records'][0]['record_id']).json()
    assert [t['answer'] for t in detail['turns']] == ['好的。', '周四下午。']
    json_file = upload(client, [{'turns': [{'question': '甲', 'answer': '一'}, {'question': '乙', 'answer': '二'}]}])
    assert save(client, json_file)[0]['records'][0]['turn_count'] == 2
    malformed = client.post('/api/answers/imports', files={'file': ('paste.txt', '助手：没有用户问题'.encode())})
    assert malformed.status_code == 201
    assert malformed.json()['errors']


def test_bad_json_and_empty_answers_are_line_errors(client):
    file = upload(client, b'{"question":"ok","answer":""}\n{"question":', 'bad.jsonl')
    p = client.post(f"/api/answers/imports/{file['import_id']}/preview", json={'mapping': file['mapping']}).json()
    assert not p['valid'] and {e['line'] for e in p['errors']} >= {1, 2}
    assert client.post(f"/api/answers/imports/{file['import_id']}/commit", json={'mapping': file['mapping'], 'reviewed_deidentified': True}).status_code == 422
    response = client.post('/api/answers/imports', files={'file': ('bad.json', b'{"x":')})
    assert response.status_code == 422 and 'JSON 第' in response.json()['detail']


def test_xlsx_reads_values_and_refuses_formulas():
    book = Workbook(); sheet = book.active
    sheet.append(['用户问题', '回答']); sheet.append(['确认时间', '周四'])
    content = io.BytesIO(); book.save(content)
    parsed = parse_file('answers.xlsx', content.getvalue())
    assert parsed['rows'][0]['value']['回答'] == '周四'
    sheet.append(['下一次', '=1+1']); content = io.BytesIO(); book.save(content)
    parsed = parse_file('answers.xlsx', content.getvalue())
    assert any(e['line'] == 3 and '公式' in e['message'] for e in parsed['errors'])


def test_duplicate_commit_is_idempotent_and_original_is_immutable(client, app):
    file = upload(client, [{'question': '确认时间', 'answer': '周四'}])
    first, reused = save(client, file)
    second, reused = save(client, file)
    assert reused and first['batch_id'] == second['batch_id']
    duplicate_upload = upload(client, [{'question': '确认时间', 'answer': '周四'}])
    same, reused = save(client, duplicate_upload)
    assert reused and same['batch_id'] == first['batch_id']
    changed = upload(client, [{'question': '确认时间', 'answer': '周五'}])
    third, _ = save(client, changed)
    assert third['batch_id'] != first['batch_id']
    assert record_detail(app.state.store, first['records'][0]['record_id'])['turns'][0]['answer'] == '周四'


def test_dataset_matching_checks_question_version_and_id(client, app):
    case = app.state.store.list_cases('clinical')[0]
    ds = app.state.store.get_dataset(case['dataset_id'])
    file = upload(client, [{'case_id': case['case_id'], 'question': case['message'], 'answer': '已有回答', 'dataset_version': ds['version']}])
    path = f"/api/answers/imports/{file['import_id']}/preview"
    p = client.post(path, json={'mapping': file['mapping'], 'dataset_id': ds['dataset_id']}).json()
    assert p['valid'] and p['matches']['matched'] == 1
    for extra in [{'question': '不同的问题'}, {'dataset_version': 'v999'}]:
        bad = upload(client, [{'case_id': case['case_id'], 'question': case['message'], 'answer': '回答', 'dataset_version': ds['version'], **extra}])
        p = client.post(f"/api/answers/imports/{bad['import_id']}/preview", json={'mapping': bad['mapping'], 'dataset_id': ds['dataset_id']}).json()
        assert not p['valid'] and p['matches']['conflict'] == 1
    missing_question = upload(client, [{'case_id': case['case_id'], 'answer': '回答', 'dataset_version': ds['version']}])
    assert client.post(f"/api/answers/imports/{missing_question['import_id']}/preview", json={'mapping': missing_question['mapping'], 'dataset_id': ds['dataset_id']}).json()['valid']


def test_key_not_persisted_and_queued_judge_is_independent(client, app, monkeypatch):
    key = 'test-key-only-for-http-fixture'
    assert client.post('/api/answers/judge', json={'api_key': key}).status_code == 200
    assert key not in client.get('/api/answers/judge').text
    file = upload(client, [{'question': '确认时间', 'answer': '周四'}]); batch, _ = save(client, file)
    record = record_detail(app.state.store, batch['records'][0]['record_id'])
    response_data = score_response(record)
    def post(url, **kwargs):
        assert 'Clinical' not in kwargs['json']['messages'][0]['content']
        assert url.endswith('/chat/completions') and kwargs['headers']['Authorization'] == 'Bearer ' + key
        return httpx.Response(200, json={'id': 'test-judge', 'usage': {'total_tokens': 11}, 'choices': [{'message': {'content': json.dumps(response_data)}}]}, request=httpx.Request('POST', url))
    monkeypatch.setattr(httpx, 'post', post)
    path = '/api/answers/batches/' + batch['batch_id'] + '/judge'
    assert client.post(path, json={}).json()['queued'] == 1
    assert client.post(path, json={}).json()['queued'] == 0
    assert app.state.answer_judge.run_one()
    judged = client.get('/api/answers/records/' + record['record_id']).json()['assessments'][0]
    assert judged['status'] == 'completed' and judged['result']['judge_calls'] == 1 and judged['result']['business_calls'] == 0
    dims = {d['dimension']: d for d in judged['result']['turns'][0]['dimensions']}
    assert dims['factual']['score'] is None and dims['context']['score'] is None
    assert key not in json.dumps(judged)
    assert client.post(path, json={}).json()['queued'] == 1
    assert client.post('/api/answers/batches/' + batch['batch_id'] + '/manage', json={'action': 'delete'}).status_code == 409
    client.post('/api/answers/batches/' + batch['batch_id'] + '/manage', json={'action': 'cancel'})
    assert client.post('/api/answers/batches/' + batch['batch_id'] + '/manage', json={'action': 'delete'}).status_code == 200
    assert client.get('/api/answers/batches').json()['items'] == []
    assert client.post('/api/answers/batches/' + batch['batch_id'] + '/manage', json={'action': 'restore'}).status_code == 200
    assert record_detail(app.state.store, record['record_id'])['turns'] == record['turns']


def test_judge_citations_and_all_turns_are_mandatory(client, app):
    file = upload(client, [{'turns': [{'question': '甲', 'answer': '一'}, {'question': '乙', 'answer': '二'}]}])
    batch, _ = save(client, file); record = record_detail(app.state.store, batch['records'][0]['record_id'])
    data = score_response(record)
    data['turns'][1]['dimensions'][1]['evidence'][0]['quote'] = '不存在的句子'
    with pytest.raises(ValueError, match='原文'):
        validate(data, record)
    data = score_response(record); data['turns'].pop()
    with pytest.raises(ValueError, match='不完整'):
        validate(data, record)
    data = score_response(record)
    data['critical_findings'] = [{'reason': '关键问题', 'evidence': [{'ref': 'turn:2:assistant', 'quote': '二'}]}]
    assert validate(data, record)['quality'] == 'fail'


def test_model_failure_retains_original_answer(client, app, monkeypatch):
    monkeypatch.setenv('DASHSCOPE_API_KEY', 'test-key-only')
    file = upload(client, [{'question': '甲', 'answer': '一'}]); batch, _ = save(client, file)
    monkeypatch.setattr(httpx, 'post', lambda *a, **k: (_ for _ in ()).throw(httpx.ConnectError('unavailable')))
    client.post('/api/answers/batches/' + batch['batch_id'] + '/judge', json={})
    assert app.state.answer_judge.run_one()
    detail = record_detail(app.state.store, batch['records'][0]['record_id'])
    assert detail['assessments'][0]['status'] == 'failed' and detail['turns'][0]['answer'] == '一'
    assert detail['assessments'][0]['result']['error_stage'] == 'judge_request'


def test_save_confirmed_regression_versions_and_generic_never_disguised_clinical(client, app):
    file = upload(client, [{'question': '请确认新的会议时间', 'answer': '错误回答'}]); batch, _ = save(client, file)
    rid = batch['records'][0]['record_id']
    payload = {'name': '会议时间回归', 'expectations': {rid: '使用用户最后一次确认的时间。'}, 'confirmed': True}
    first = client.post('/api/answers/regression', json=payload)
    assert first.status_code == 201, first.text
    ds = first.json(); assert ds['profile'] == 'generic'
    assert any(d['dataset_id'] == ds['dataset_id'] for d in client.get('/api/datasets').json()['items'])
    cases = client.get('/api/cases?dataset_id=' + ds['dataset_id']).json()['items']
    assert cases[0]['agent'] == 'generic' and '错误回答' not in json.dumps(cases)
    assert cases[0]['expected']['behavior_expectation'] == payload['expectations'][rid]
    second = client.post('/api/answers/regression', json={**payload, 'dataset_id': ds['dataset_id']})
    assert second.status_code == 201 and second.json()['version'] == 'v2'
    assert app.state.store.get_dataset(ds['dataset_id'])['content_sha256'] == ds['content_sha256']
    assert client.post('/api/batches', json={'case_ids': [cases[0]['case_id']], 'label': 'wrong'}).status_code == 403


def test_cross_site_missing_header_and_sensitive_material(client):
    assert client.post('/api/answers/imports', headers={'X-EVO-Answers': ''}, files={'file': ('a.json', b'[]')}).status_code == 403
    assert client.post('/api/answers/imports', headers={'Origin': 'https://elsewhere.example'}, files={'file': ('a.json', b'[]')}).status_code == 403
    response = client.post('/api/answers/imports', files={'file': ('a.json', b'[{"question":"q","answer":"a","api_key":"secret"}]')})
    assert response.status_code == 422 and '脱敏' in response.json()['detail']


def test_linked_dataset_expectations_are_used_by_judge_without_becoming_facts(client, app):
    file = upload(client, [{'question': '把会议改到周四', 'answer': '周五'}]); batch, _ = save(client, file)
    rid = batch['records'][0]['record_id']
    ds = client.post('/api/answers/regression', json={'name': '时间', 'expectations': {rid: '必须采用周四'}, 'confirmed': True}).json()
    case = app.state.store.list_cases('generic', ds['dataset_id'])[0]
    matched = upload(client, [{'case_id': case['case_id'], 'dataset_version': ds['version'], 'question': '把会议改到周四', 'answer': '周五'}])
    linked, _ = save(client, matched, dataset_id=ds['dataset_id'])
    record = record_detail(app.state.store, linked['records'][0]['record_id'])
    evidence = material(record)
    assert any(r['ref'] == 'turn:1:expectation' and '必须采用周四' in r['text'] for r in evidence)
    assert next(d for d in validate(score_response(record), record)['turns'][0]['dimensions'] if d['dimension'] == 'factual')['score'] is None


def test_nonfinite_json_and_credentials_in_wrapper_are_rejected(client):
    for raw in [b'[{"question":"q","answer":"a","number":NaN}]',
                b'{"api_key":"secret-value","items":[{"question":"q","answer":"a"}]}']:
        result = client.post('/api/answers/imports', files={'file': ('bad.json', raw)})
        assert result.status_code == 422


def test_long_conversation_preserves_all_turns_and_marks_cross_segment_context(app, monkeypatch):
    monkeypatch.setenv('DASHSCOPE_API_KEY', 'test-key-only')
    record = {'turns': [{'turn': i, 'question': f'第{i}轮问题' + '问' * 10000,
                        'answer': f'第{i}轮回答' + '答' * 20000, 'reference': ''} for i in range(1, 7)]}
    requests, progress = [], []
    def post(url, **kwargs):
        sent = json.loads(kwargs['json']['messages'][1]['content'])
        requests.append(sent)
        selected = {'turns': [t for t in record['turns'] if t['turn'] in sent['turn_numbers']]}
        assert sent['records'] == material(selected)
        return httpx.Response(200, json={'id': 'fixture-segment', 'usage': {'total_tokens': 1},
            'choices': [{'message': {'content': json.dumps(score_response(selected))}}]}, request=httpx.Request('POST', url))
    monkeypatch.setattr(httpx, 'post', post)
    status, result = app.state.answer_judge.evaluate(record, progress.append)
    assert status == 'completed' and result['quality'] == 'unjudged'
    assert [r['turn_numbers'] for r in requests] == [[1, 2], [3, 4], [5, 6]]
    assert result['judge_calls'] == 3 and result['reviewed_turns'] == 6 and len(progress) == 3
    assert [t['turn'] for t in result['turns']] == list(range(1, 7))
    assert all(next(d for d in t['dimensions'] if d['dimension'] == 'context')['score'] is None for t in result['turns'][2:])
    assert result['context_coverage'] == 'partial' and result['business_calls'] == 0


def test_oversize_single_turn_is_not_silently_truncated(app, monkeypatch):
    monkeypatch.setenv('DASHSCOPE_API_KEY', 'test-key-only')
    monkeypatch.setattr(httpx, 'post', lambda *a, **k: pytest.fail('超限材料不可截断后调用'))
    status, result = app.state.answer_judge.evaluate({'turns': [
        {'turn': 1, 'question': '问' * 40000, 'answer': '答' * 40000, 'reference': '据' * 40000}]})
    assert status == 'unjudged' and result['judge_calls'] == 0 and result['error_stage'] == 'evidence_budget'


def test_restart_keeps_already_judged_segments(client, app, monkeypatch):
    monkeypatch.setenv('DASHSCOPE_API_KEY', 'test-key-only')
    file = upload(client, [{'question': '确认时间', 'answer': '周四'}]); batch, _ = save(client, file)
    client.post('/api/answers/batches/' + batch['batch_id'] + '/judge', json={})
    partial = {'segments': [{'turn_range': [1, 2], 'judge_calls': 1}], 'judge_calls': 1}
    with app.state.store.connect() as db:
        db.execute("UPDATE answer_assessments SET status='running',result_json=?", (json.dumps(partial),))
    monkeypatch.setattr(app.state.answer_judge, 'loop', lambda: None)
    app.state.answer_judge.start()
    app.state.answer_judge.stop()
    result = client.get('/api/answers/records/' + batch['records'][0]['record_id']).json()['assessments'][0]
    assert result['status'] == 'interrupted' and result['result']['segments'] == partial['segments']
    assert result['result']['judge_calls'] == 1


def test_browser_judge_keeps_visitor_key_separate_from_native_queue(client, app, monkeypatch):
    app.state.answer_judge.configure('native-fixture-key', 'qwen3.6-flash')
    record = {'turns': [{'turn': 1, 'question': '确认周四', 'answer': '周四。', 'reference': ''}]}
    def post(url, **kwargs):
        assert kwargs['headers']['Authorization'] == 'Bearer visitor-fixture-key'
        return httpx.Response(200, json={'id': 'fixture', 'usage': {}, 'choices': [
            {'message': {'content': json.dumps(score_response(record))}}]}, request=httpx.Request('POST', url))
    monkeypatch.setattr(httpx, 'post', post)
    response = client.post('/api/answers/visitor-judge', headers={'Authorization': 'Bearer visitor-fixture-key'},
                           json={'record': record, 'model': 'qwen3.6-flash'})
    assert response.status_code == 200 and response.json()['status'] == 'completed'
    assert app.state.answer_judge.key == 'native-fixture-key'
    assert 'visitor-fixture-key' not in response.text
