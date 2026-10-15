"""Read-only, versioned report snapshots. Quality and execution are separate axes."""
from __future__ import annotations

import hashlib
import json
import math
import re
from collections import defaultdict
from pathlib import Path

_POLICY = json.loads(Path(__file__).with_name("report_policy.json").read_text(encoding="utf-8"))

VERSION = _POLICY['version']
MODEL = _POLICY['model']
DIMS = {'answers': ['factual', 'coverage', 'relevance', 'context'],
        'native': ['evidence_consistency', 'coverage', 'context', 'clarity']}


def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items() if not re.search(r'password|secret|api.?key|authorization|access.?token', k, re.I)}
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, str):
        return re.sub(r'\bsk-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]+', '[凭证已移除]', value, flags=re.I)
    return value


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def mean(values):
    return sum(values) / len(values) if values else None


def score_value(value):
    return value if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 5 else None


def answer_unit(record):
    turns = record['turns']
    latest = next(iter(record.get('assessments', [])), {})  # Never fall back to an older successful judge.
    result = latest.get('result') or {}
    judged = {t['turn']: t for t in result.get('turns', [])}
    keys = DIMS['answers'] if len(turns) > 1 else DIMS['answers'][:-1]
    scores, low = {}, []
    for key in keys:
        values = []
        for i, turn in enumerate(turns):
            if key == 'context' and i == 0:
                continue
            row = next((d for d in judged.get(turn['turn'], {}).get('dimensions', []) if d['dimension'] == key), {})
            value = score_value(row.get('score')) if latest.get('status') == 'completed' else None
            if key == 'factual' and not turn.get('reference', '').strip():
                value = None
            values.append(value)
            if value is not None and value < 3:
                low.append({'turn': turn['turn'], 'dimension': key, 'score': value, 'reason': row.get('reason', '')})
        scores[key] = mean(values) if values and all(v is not None for v in values) else None
    evidence = []
    for turn in turns:
        for role, field in [('user', 'question'), ('assistant', 'answer'), ('reference', 'reference')]:
            if turn.get(field):
                evidence.append({'ref': f"turn:{turn['turn']}:{role}", 'text': turn[field]})
    return {'id': record['record_id'], 'question_key': record['record_id'],
            'profile': 'answers-' + ('multi' if len(turns) > 1 else 'single'), 'dimensions': scores,
            'title': turns[0]['question'], 'turn_count': len(turns), 'execution': 'uploaded_unverified',
            'assessment_id': latest.get('assessment_id'), 'assessment_status': latest.get('status', 'not_started'),
            'assessment_issue': None if latest.get('status') == 'completed' else clean(result.get('reason')),
            'rubric': result.get('rubric_version', 'answer-review-v3'), 'quality': result.get('quality', 'unjudged'),
            'judge_model': result.get('model'),
            'critical': [{'kind': 'ai_pending', **v} for v in result.get('critical_findings', [])],
            'low_turns': low, 'evidence': evidence, 'source': record.get('source', {}),
            'linked_cases': [t.get('linked_case') for t in turns], 'repeat_eligible': False,
            'retry': False, 'usage': result.get('usage', []), 'trace_coverage': 'unverified'}


def native_unit(run):
    from agent_evo.evidence import observations, latest_verdicts, quality_state, trace_overview
    assessments = [e['payload'] for e in run['events'] if e['node'] == 'assessment.result' and e['payload'].get('mode') == 'quality']
    latest = assessments[-1] if assessments else {}
    diagnoses = [e['payload'] for e in run['events'] if e['node'] == 'assessment.result' and e['payload'].get('mode') == 'diagnosis']
    dimensions = (latest.get('result') or {}).get('dimensions', [])
    obs = observations(run)
    # Planned turns, including a turn that never produced an answer, remain in scope.
    turns = max(1, len(run['case'].get('turns') or []), max((o['turn_index'] for o in obs), default=1))
    keys = [k for k in DIMS['native'] if k != 'context' or turns > 1]
    scores = {k: score_value(next((d.get('score') for d in dimensions if d['dimension'] == k), None))
              if latest.get('status') == 'completed' and run['status'] == 'completed' else None for k in keys}
    critical = [{'kind': 'human' if v.get('reviewer') else 'rule', 'reason': v['rationale'], 'evidence': v.get('evidence', [])}
                for v in latest_verdicts(run['verdicts']) if v['critical'] and v['result'] == 'fail']
    return {'id': run['run_id'], 'question_key': '|'.join([str(run.get('dataset_id')), str(run['case_id']), str(run.get('case_sha256') or run['case'].get('sha256'))]),
            'profile': 'native-' + ('multi' if turns > 1 else 'single'), 'dimensions': scores,
            'title': run['case'].get('message', run['case_id']), 'turn_count': turns, 'execution': run['status'],
            'assessment_id': latest.get('assessment_id'), 'assessment_status': latest.get('status', 'not_started'),
            'rubric': latest.get('rubric', {}), 'quality': quality_state(run, run['verdicts']), 'critical': critical,
            'judge_model': latest.get('model'), 'diagnosis': diagnoses[-1] if diagnoses else None,
            'assessment_limits': [{'dimension': d['dimension'], 'reason': d.get('reason', '')}
                                  for d in dimensions if d.get('score') is None and d['dimension'] in keys],
            'critical_unjudged': sum(bool(v.get('critical')) and v['result'] == 'unjudged' for v in latest_verdicts(run['verdicts'])),
            'low_turns': [{'turn': None, 'dimension': d['dimension'], 'score': d['score'], 'reason': d.get('reason', '')}
                          for d in dimensions if score_value(d.get('score')) is not None and d['score'] < 3],
            'evidence': [{'ref': o['id'], 'text': o['data'] if isinstance(o['data'], str) else canonical(o['data'])} for o in obs],
            'source': {'agent': run.get('agent'), 'agent_id': run.get('agent_id'), 'dataset_id': run.get('dataset_id'), 'case_id': run['case_id'], 'sha256': run.get('case_sha256') or run['case'].get('sha256'), 'versions': run.get('version'), 'execution_mode': run.get('execution_mode')},
            'repeat_eligible': run.get('execution_mode') != 'recorded', 'retry': bool(run.get('retry_of')),
            'usage': run.get('model_evidence'), 'trace_coverage': trace_overview(run)['coverage']}


def metrics(units, repetitions=1):
    planned = [u for u in units if not u.get('retry')]
    profiles = []
    for profile in sorted({u['profile'] for u in planned}):
        members = [u for u in planned if u['profile'] == profile]
        complete = [u for u in members if u['dimensions'] and all(score_value(v) is not None for v in u['dimensions'].values())]
        by_question = defaultdict(list)
        for u in complete:
            by_question[u['question_key']].append(mean(list(u['dimensions'].values())) * 20)
        partial = mean([mean(v) for v in by_question.values()])
        dims = {}
        for key in sorted({k for u in members for k in u['dimensions']}):
            groups = defaultdict(list)
            for u in members:
                value = score_value(u['dimensions'].get(key))
                if value is not None:
                    groups[u['question_key']].append(value)
            dims[key] = {'score': mean([mean(v) for v in groups.values()]), 'scored': sum(len(v) for v in groups.values()), 'planned': len(members)}
        profiles.append({'profile': profile, 'score': partial if len(complete) == len(members) else None,
                         'partial_score': partial, 'scored': len(complete), 'planned': len(members), 'dimensions': dims})
    groups = defaultdict(list)
    for u in planned:
        groups[u['question_key']].append(u)
    judged_groups = [[u for u in g if u['quality'] in ('pass', 'fail') and u['execution'] in ('completed', 'uploaded_unverified')
                      and u['dimensions'] and all(score_value(v) is not None for v in u['dimensions'].values())] for g in groups.values()]
    judged_groups = [g for g in judged_groups if g]
    stability_groups = [g for g in groups.values() if repetitions >= 2 and all(u.get('repeat_eligible') for u in g)]
    full = sum(len(g) == repetitions and all(u['quality'] == 'pass' and u['execution'] == 'completed' and u['dimensions']
               and all(score_value(v) is not None for v in u['dimensions'].values()) for u in g) for g in stability_groups)
    stability_complete = all(len(g) == repetitions and all(u['dimensions'] and all(score_value(v) is not None for v in u['dimensions'].values()) for u in g) for g in stability_groups)
    critical = {k: sum(c.get('kind') == k for u in planned for c in u['critical']) for k in ['rule', 'ai_pending', 'human']}
    return {'planned': len(planned), 'questions': len(groups), 'turns': sum(u['turn_count'] for u in planned),
            'scored': sum(p['scored'] for p in profiles), 'profiles': profiles,
            'assessed': sum(u['assessment_status'] == 'completed' for u in planned),
            'critical_unjudged': sum(u.get('critical_unjudged', 0) for u in planned),
            'score': profiles[0]['score'] if len(profiles) == 1 else None,
            'partial_score': profiles[0]['partial_score'] if len(profiles) == 1 else None,
            'pass_rate': mean([sum(u['quality'] == 'pass' for u in g) / len(g) for g in judged_groups]),
            'judged': sum(len(g) for g in judged_groups),
            'execution_failed': sum(u['execution'] in ('failed', 'blocked', 'timed_out', 'cancelled') for u in planned),
            'judge_failed': sum(u['assessment_status'] in ('failed', 'unjudged', 'interrupted', 'cancelled') for u in planned),
            'critical': critical, 'stability': full / len(stability_groups) if stability_groups and stability_complete else None,
            'stability_questions': len(stability_groups), 'repetitions': repetitions,
            'retries_excluded': len(units) - len(planned), 'business_calls': 0}


def snapshot(store, source, batch_id):
    if source == 'answers':
        from agent_evo.answer_imports import list_batches, record_detail
        batch = next((b for b in list_batches(store) + list_batches(store, True) if b['batch_id'] == batch_id), None)
        if batch is None:
            raise KeyError('批次不存在')
        units = [answer_unit(record_detail(store, r['record_id'])) for r in batch['records']]
        name, repetitions = batch['name'], 1
    elif source == 'native':
        from agent_evo.clinical_scope import clinical_batch
        batch = clinical_batch(store.get_batch(batch_id))
        units = []
        for r in batch['runs']:
            run = store.get_run(r['run_id'])
            run.update(case=store.get_case(run['case_id']), events=store.events(run['run_id']), verdicts=store.verdicts(run['run_id']))
            units.append(native_unit(run))
        name, repetitions = batch['label'], batch.get('repetitions', 1)
    else:
        raise ValueError('不支持的报告来源')
    value = clean({'version': VERSION, 'source': source, 'batch_id': batch_id, 'name': name,
                   'scoring_contract': {'version': 'evo-score-v1', 'weights': 'equal_applicable_dimensions', 'selection': 'latest_assessment_no_fallback', 'unknown': 'no_composite', 'aggregation': 'per_question_macro'},
                   'units': units, 'metrics': metrics(units, repetitions), 'provenance': 'local_saved_records'})
    return {**value, 'snapshot_id': digest(value)}


def ai_material(snap):
    """Bounded selection is explicit; the frozen report appendix keeps every record."""
    ordered = sorted(snap['units'], key=lambda u: (not bool(u['critical']), u['quality'] != 'fail', not bool(u['low_turns']), u['id']))
    selected, size = [], 0
    for unit in ordered:
        # Extract original snippets. Never send hidden instructions or entire unrelated source files.
        evidence = [{'ref': e['ref'], 'text': e['text'][:900]} for e in unit['evidence'][:10]]
        item = {k: unit[k] for k in ['id', 'profile', 'dimensions', 'assessment_status', 'quality', 'critical', 'low_turns', 'trace_coverage']}
        if unit.get('assessment_limits'):
            item['assessment_limits'] = unit['assessment_limits']
        item['evidence'] = evidence
        cost = len(canonical(item))
        if size + cost > 52000 or len(selected) >= 24:
            break
        size += cost
        selected.append(item)
    return {'metrics': snap['metrics'], 'records': selected, 'coverage': {'selected': len(selected), 'total': len(ordered)}, 'version': VERSION}


REPORT_SYSTEM = _POLICY['system']


def validate_report(value, material):
    sections = ['summary', 'strengths', 'issues', 'recommendations', 'limitations']
    if not isinstance(value, dict) or set(value) != set(sections):
        raise ValueError('报告章节不完整')
    refs = {(u['id'], e['ref']): e['text'] for u in material['records'] for e in u['evidence']}
    metrics_map = material['metrics']
    for section in sections:
        rows = value[section]
        if not isinstance(rows, list) or len(rows) > 8 or (section in ('summary', 'limitations') and not rows):
            raise ValueError('报告章节数量无效')
        for row in rows:
            if not isinstance(row, dict) or set(row) != {'text', 'metric_refs', 'evidence'}:
                raise ValueError('报告条目格式无效')
            text = row['text']
            if not isinstance(text, str) or not 2 <= len(text) <= 1600 or re.search(r'\d|临床验证通过|可以上线|可安全上线|根因已确认', text):
                raise ValueError('报告含未允许的指标或确定性结论')
            if not isinstance(row['metric_refs'], list) or len(row['metric_refs']) > 12 or not isinstance(row['evidence'], list) or len(row['evidence']) > 8:
                raise ValueError('报告引用格式无效')
            if not row['metric_refs'] and not row['evidence']:
                raise ValueError('报告缺少依据')
            for ref in row['metric_refs']:
                if not isinstance(ref, str) or ref not in metrics_map or isinstance(metrics_map[ref], (dict, list)):
                    raise ValueError('指标引用不存在')
            if section in ('issues', 'recommendations') and not row['evidence']:
                raise ValueError('问题与改进必须引用原文')
            for e in row['evidence']:
                if not isinstance(e, dict) or set(e) != {'record_id', 'ref', 'quote'} or not isinstance(e.get('record_id'), str) or not isinstance(e.get('ref'), str):
                    raise ValueError('证据引用格式无效')
                original = refs.get((e['record_id'], e['ref']))
                if original is None:
                    raise ValueError(f"{section}：证据不存在或跨记录：{e['record_id']} / {e['ref']}；请从给定 evidence 选择实际 ref")
                if not isinstance(e['quote'], str) or not 2 <= len(e['quote']) <= 300 or e['quote'] not in original:
                    raise ValueError(f"{section}：{e['record_id']} / {e['ref']} 引用必须是二至三百字的连续原文，保留 Markdown 和标点")
    return value
