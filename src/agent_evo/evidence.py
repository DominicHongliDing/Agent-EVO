"""Read-only evidence projections. Missing observations never imply success."""
from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict

EXECUTION_DIMENSIONS = {'business_execution', 'business_node', 'live_model', 'recorded_model',
                        'context_model_evidence', 'recorded_answer', 'retrieval_execution'}
ENVIRONMENT_ERRORS = {'ConnectError', 'ConnectTimeout', 'connection_unavailable', 'invalid_fixture',
                      'clinical_submit_failed', 'clinical_credentials_missing', 'interrupted_unknown',
                      'unihr_credentials_missing', 'unihr_usage_unconfigured', 'nonlocal_target'}


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def execution_category(run):
    if run.get('error_code') in ENVIRONMENT_ERRORS or run['status'] == 'blocked':
        return 'environment_blocked'
    return {'completed': 'completed', 'failed': 'agent_failed', 'timed_out': 'execution_timeout',
            'cancelled': 'cancelled', 'queued': 'queued', 'running': 'running'}.get(run['status'], 'unknown')


def latest_verdicts(verdicts):
    # Each evaluation emits one diagnosis event; within an evaluation multiple
    # turns can share a dimension. Keep turn-specific assertions independently.
    latest = {}
    for v in verdicts:
        turn = re.search(r'第\s*(\d+)\s*轮', v.get('rationale', ''))
        key = (v['dimension'], v.get('evaluator'), turn.group(1) if turn else '')
        latest[key] = v
    return list(latest.values())


def quality_state(run, verdicts):
    if run['status'] != 'completed':
        return 'unjudged'
    values = [v for v in latest_verdicts(verdicts) if v['dimension'] not in EXECUTION_DIMENSIONS]
    if any(v['result'] == 'fail' for v in values):
        return 'fail'
    if not values or any(v['result'] == 'unjudged' for v in values):
        return 'unjudged'
    return 'pass'


def observations(run):
    """Stable IDs point to original saved records, including calls with no reply."""
    result = []
    output = run.get('output') or {}
    turns = output.get('conversation_turns') or []
    if not turns:
        turns = [{'turn_index': 1, 'message': (run.get('case') or {}).get('message', ''), 'output': output}]
    from agent_evo.conversation import answer_text
    for row in turns:
        index = row['turn_index']
        for role, content in [('user', row.get('message', '')), ('assistant', answer_text(row.get('output') or {}))]:
            if content:
                result.append({'id': f'turn:{index}:{role}', 'turn_index': index, 'node': role,
                               'kind': 'conversation', 'status': row.get('status', run['status']),
                               'coverage': 'full' if role == 'user' or row.get('answer_coverage', 'full') == 'full' else 'partial',
                               'data': content})
        saved_result = (row.get('output') or {}).get('result') or {}
        if isinstance(saved_result, dict):
            for source_index, source in enumerate(saved_result.get('citations') or [], 1):
                if isinstance(source, dict) and source.get('evidence_snippet'):
                    result.append({'id': f'turn:{index}:source:{source_index}', 'turn_index': index,
                        'node': 'retrieved_source', 'kind': 'retrieval_evidence', 'status': 'observed',
                        'coverage': 'partial', 'data': {k: source[k] for k in
                            ('chunk_id', 'source_id', 'label', 'document_title', 'evidence_snippet', 'source_version') if k in source}})
    for event in run.get('events', []):
        if event['kind'] not in {'business_event', 'business_step', 'business_trace', 'model_call'}:
            continue
        p = event.get('payload') or {}
        result.append({'id': f"event:{event['seq']}", 'turn_index': p.get('turn_index', 1),
                       'node': event['node'], 'kind': event['kind'], 'status': event['status'],
                       'coverage': p.get('coverage', 'partial'), 'span_id': event['span_id'],
                       'source_sequence': p.get('sequence'), 'data': p})
    return result


def trace_overview(run):
    rows = observations(run)
    calls = [r for r in rows if r['kind'] == 'model_call']
    expected = (run.get('model_evidence') or {}).get('main_calls', run.get('model_calls', 0))
    full = bool(calls) and all(c['coverage'] == 'full' for c in calls) and len([c for c in calls if c['status'] == 'success']) >= expected
    return {'coverage': 'full' if full else 'partial' if calls else 'missing',
            'model_calls_saved': len(calls), 'expected_successful_calls': expected,
            'note': '覆盖当前已采集模型调用；不代表未采集的工具或内部状态完整。' if full else '历史摘要不能还原实际模型请求；未采集的输入明确留空。',
            'items': [{k: v for k, v in r.items() if k != 'data'} | {'preview': encode(r['data'])[:240]} for r in rows]}


def trace_detail(run, evidence_id):
    row = next((r for r in observations(run) if r['id'] == evidence_id), None)
    if row is None:
        raise KeyError('证据不存在')
    return row


def trace_search(run, keyword):
    if not isinstance(keyword, str) or not 1 <= len(keyword.strip()) <= 120:
        raise ValueError('请输入 1–120 字的信息或数值')
    matches = []
    for row in observations(run):
        body = row['data'] if isinstance(row['data'], str) else encode(row['data'])
        position = body.casefold().find(keyword.casefold())
        if position >= 0:
            matches.append({k: v for k, v in row.items() if k != 'data'} | {'excerpt': body[max(0, position-100):position+len(keyword)+180]})
    # Cross-source ordering is deliberately not inferred from ingestion time.
    matches.sort(key=lambda r: (r['turn_index'], 0 if r['node'] == 'user' else 1 if r['kind'] == 'model_call' else 2))
    return {'keyword': keyword, 'items': matches[:100], 'total': len(matches),
            'note': '按对话轮次展示命中；同轮跨来源顺序可能不完整。首现是来源线索，不能直接判定根因。'}


def summary(run):
    verdicts = latest_verdicts(run.get('verdicts', []))
    diagnoses = [e['payload'] for e in run.get('events', []) if e['node'] == 'diagnosis']
    diagnosis = diagnoses[-1] if diagnoses else {}
    failures = [v for v in verdicts if v['result'] == 'fail']
    return {'execution': execution_category(run), 'quality': quality_state(run, verdicts),
            'critical_failures': sum(bool(v.get('critical')) for v in failures),
            'critical_unjudged': sum(bool(v.get('critical')) and v['result'] == 'unjudged' for v in verdicts),
            'priority_issue': diagnosis.get('priority_issue', diagnosis.get('first_failure')),
            'root_cause_status': 'unconfirmed', 'trace': trace_overview(run)}


def stability(store, batch):
    grouped = defaultdict(list)
    for item in batch['runs']:
        run = store.get_run(item['run_id'])
        # A manual retry is visible but does not silently become a planned repeat.
        if run.get('retry_of'):
            continue
        grouped[run['case_id']].append(run)
    groups, ratios = [], []
    planned_n = int(batch.get('repetitions') or 1)
    for case_id, rows in grouped.items():
        states = [quality_state(r, store.verdicts(r['run_id'])) for r in rows]
        judged = sum(v in {'pass', 'fail'} for v in states)
        passed = states.count('pass')
        rate = passed / judged if judged else None
        if rate is not None:
            ratios.append(rate)
        complete = len(rows) == planned_n and judged == planned_n
        groups.append({'case_id': case_id, 'title': store.get_case(case_id)['title'], 'planned': planned_n,
                       'judged': judged, 'passed': passed, 'rate': rate, 'complete': complete,
                       'all_passed': complete and passed == planned_n,
                       'runs': [{'run_id': r['run_id'], 'repetition_index': r.get('repetition_index', 1),
                                 'execution': execution_category(r), 'quality': s} for r, s in zip(rows, states)]})
    planned = sum(g['planned'] for g in groups)
    judged = sum(g['judged'] for g in groups)
    complete = sum(g['complete'] for g in groups)
    return {'planned': planned, 'judged': judged, 'coverage': judged / planned if planned else None,
            'case_count': len(groups), 'covered_cases': len(ratios),
            'macro_pass_rate': sum(ratios)/len(ratios) if ratios else None,
            'complete_cases': complete, 'all_passed_cases': sum(g['all_passed'] for g in groups),
            'all_pass_rate': sum(g['all_passed'] for g in groups)/complete if complete else None,
            'repetitions': planned_n, 'groups': groups,
            'note': '通过率先按题再平均；稳定性仅统计计划遍次全部已判的题，缺失/失败执行不算全部通过。手动重跑另列。'}


def compare_records(left, right):
    comparable = left['case_sha256'] == right['case_sha256']
    lv, rv = left.get('version') or {}, right.get('version') or {}
    keys = set(lv) | set(rv)
    return {'same_case': comparable, 'version_changes': [{'name': k, 'left': lv.get(k), 'right': rv.get(k)} for k in sorted(keys) if lv.get(k) != rv.get(k)],
            'left': {'run_id': left['run_id'], 'status': left['status'], 'output': left.get('output'), 'trace': trace_overview(left)},
            'right': {'run_id': right['run_id'], 'status': right['status'], 'output': right.get('output'), 'trace': trace_overview(right)},
            'note': '相同用例不代表其他变量相同；请结合版本差异解释变化。'}


def import_model_evidence(store, run_id, source_root, business_id):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', business_id):
        return
    path = source_root / '.local' / 'evo-evidence' / (business_id + '.jsonl')
    if not path.is_file() or path.stat().st_size > 16 * 1024 * 1024:
        return
    existing = {e['payload'].get('call_id') for e in store.events(run_id) if e['kind'] == 'model_call'}
    for line in path.read_text(encoding='utf-8').splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if not isinstance(value, dict) or not value.get('call_id') or value.get('business_run_id') != business_id or value.get('synthetic') is not True or value.get('call_id') in existing:
            continue
        store.add_event(run_id, 'model_call', value.get('node') or 'model.request', value.get('status', 'unknown'), value)
        existing.add(value.get('call_id'))
