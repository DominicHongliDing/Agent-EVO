"""Durable Langfuse v4 OTLP export; business execution never occurs in this module."""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit
from uuid import UUID

import httpx

from agent_evo.script_store import binding
from agent_evo.store import dumps, now

PROTOCOL = 'langfuse-v4-otel-2026-10-11'
TERMINAL = {'completed', 'failed', 'blocked', 'timed_out', 'cancelled'}


def stable(value, length=32):
    return hashlib.sha256(value.encode()).hexdigest()[:length]


def redact(value):
    """Defense in depth; publishing requires an explicitly selected deidentified case."""
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items() if not re.search(
            r'password|secret|api.?key|access.?token|authorization|cookie|local_path|source_root|working_directory|interpreter|payload_json|evidence_json|agent_snapshot|reviewer', k, re.I)}
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, str):
        value = re.sub(r'(?i)\b(?:sk|pk)-[a-z0-9_-]{8,}', '[已移除凭证]', value)
        value = re.sub(r'(?i)Bearer\s+\S+', 'Bearer [已移除]', value)
        value = re.sub(r'[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}', '[已移除邮箱]', value)
        value = re.sub(r'(?<!\d)1[3-9]\d{9}(?!\d)', '[已移除手机号]', value)
        value = re.sub(r'(?<!\d)\d{17}[\dXx](?!\w)', '[已移除证件号]', value)
        value = re.sub(r'(?i)[a-z]:[\\/][^\s"<>]+', '[本地路径]', value)
    return value


def snapshot(store, run_id):
    run = store.get_run(run_id)
    case = store.get_case(run['case_id'])
    if case['agent'] != 'clinical' or not case.get('synthetic'):
        raise ValueError('第一版仅同步明确标记为合成或脱敏的 Clinical 用例')
    permitted = ('run_id', 'batch_id', 'case_id', 'trace_id', 'status', 'started_at', 'finished_at',
                 'business_run_id', 'business_execution_id', 'model_calls', 'model_evidence', 'output',
                 'error_code', 'version', 'case_sha256', 'retry_of', 'execution_mode', 'dataset_id')
    return redact({**{k: run.get(k) for k in permitted}, 'case': case,
        'events': store.events(run_id), 'verdicts': store.verdicts(run_id),
        'script': binding(store, run_id), 'batch_label': store.get_batch(run['batch_id'])['label'],
        'evidence_origin': 'captured_business_event', 'clinical_validation': 'not_performed', 'export_protocol': PROTOCOL})


def quality(record):
    from agent_evo.evidence import quality_state
    if (record.get('script') or {}).get('evaluator_status') in {'failed', 'interrupted', 'pending', 'not_started'}:
        return 'unjudged'
    return quality_state(record, record.get('verdicts', []))


def nanos(timestamp):
    # Integer conversion preserves source microseconds without float rounding.
    delta = datetime.fromisoformat(timestamp.replace('Z', '+00:00')) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return str((delta.days * 86400 + delta.seconds) * 10**9 + delta.microseconds * 1000)


def attributes(values):
    return [{'key': k, 'value': {'boolValue': v} if isinstance(v, bool) else {'stringValue': v if isinstance(v, str) else dumps(v)}} for k, v in values.items()]


def export_payload(record):
    run_id = record['run_id']
    trace = record['trace_id']
    root_id = stable(run_id + ':root', 16)
    revision = stable(dumps(record), 64)
    stamp = record['started_at'] or record['finished_at']
    if not stamp:
        raise ValueError('记录缺少原始时间，无法可靠回填')
    common = {
        'langfuse.trace.name': record['case']['title'], 'langfuse.trace.public': False,
        'langfuse.session.id': 'evo-session-' + run_id, 'langfuse.environment': 'evo-local',
        'langfuse.trace.metadata.evo_run_id': run_id, 'langfuse.trace.metadata.evo_batch_id': record['batch_id'],
        'langfuse.experiment.id': record['batch_id'],
        'langfuse.experiment.name': record['batch_label'] + ' · ' + record['batch_id'][-8:],
        'langfuse.experiment.dataset.id': record['dataset_id'],
        'langfuse.experiment.item.id': record['case_id'],
        'langfuse.experiment.item.root_observation_id': root_id,
    }
    spans = [{'traceId': trace, 'spanId': root_id, 'name': 'Clinical 评测记录', 'kind': 1,
        'startTimeUnixNano': nanos(stamp), 'endTimeUnixNano': nanos(record['finished_at'] or stamp),
        'attributes': attributes({**common, 'langfuse.observation.type': 'span',
            'langfuse.observation.input': dumps({'message': record['case'].get('message'), 'turns': record['case'].get('turns')}),
            'langfuse.observation.output': dumps(record.get('output')),
            'langfuse.observation.metadata.evo_record': dumps(record),
            'langfuse.observation.metadata.evo_revision': revision,
            'langfuse.observation.metadata.evo_protocol': PROTOCOL})}]
    turn_ids = {}
    for turn in (record.get('output') or {}).get('conversation_turns', []):
        if not turn.get('started_at'):
            continue
        index = turn['turn_index']
        turn_id = stable(run_id + ':turn:' + str(index), 16)
        turn_ids[index] = turn_id
        spans.append({'traceId': trace, 'spanId': turn_id, 'parentSpanId': root_id, 'name': f'第 {index} 轮对话', 'kind': 1,
            'startTimeUnixNano': nanos(turn['started_at']), 'endTimeUnixNano': nanos(turn.get('finished_at') or turn['started_at']),
            'attributes': attributes({**common, 'langfuse.observation.type': 'span',
                'langfuse.observation.input': turn['message'], 'langfuse.observation.output': dumps(turn.get('output')),
                'langfuse.observation.metadata.turn_index': str(index),
                'langfuse.observation.metadata.business_run_id': turn.get('business_run_id'),
                'langfuse.observation.metadata.session_verified': bool(turn.get('session_verified'))})})
    event_ids = {e['span_id'] for e in record['events']}
    for event in record['events']:
        # Capture time is a point event, not an invented business duration.
        spans.append({'traceId': trace, 'spanId': event['span_id'],
            'parentSpanId': event['parent_span_id'] if event['parent_span_id'] in event_ids else turn_ids.get((event.get('payload') or {}).get('turn_index') if isinstance(event.get('payload'), dict) else None, root_id),
            'name': event['node'], 'kind': 1,
            'startTimeUnixNano': nanos(event['created_at']), 'endTimeUnixNano': nanos(event['created_at']),
            'attributes': attributes({**common, 'langfuse.observation.type': 'event',
                'langfuse.observation.output': dumps(event['payload']),
                'langfuse.observation.metadata.evo_event_id': str(event['seq']),
                'langfuse.observation.metadata.evidence_origin': 'captured_business_event',
                'langfuse.observation.metadata.evo_status': event['status']})})
    evidence = record.get('model_evidence') or {}
    groups = [(t.get('turn_index'), t.get('model_evidence') or {}) for t in evidence.get('turns', [])] if evidence.get('turns') else [(None, evidence)]
    for turn_index, group in groups:
        if not group.get('verified'):
            continue
        usage = group.get('model_usage') or group
        for index, event in enumerate(usage.get('events', [])):
            if not isinstance(event, dict) or not event.get('model_name'):
                continue
            values = {**common, 'langfuse.observation.type': 'generation', 'langfuse.observation.model.name': event['model_name'],
                'langfuse.observation.output': dumps(event), 'langfuse.observation.metadata.timing_mode': 'capture_time_only',
                'langfuse.observation.metadata.evidence_origin': 'business_model_usage',
                'langfuse.observation.metadata.model_io_available': False,
                'langfuse.observation.metadata.reported_latency_ms': event.get('latency_ms'),
                'langfuse.observation.metadata.cost_status': event.get('cost_status') or 'not_configured',
                'langfuse.observation.level': 'ERROR' if event.get('status') in {'error', 'failed'} else 'DEFAULT'}
            if event.get('usage_status') == 'provider_reported':
                values['langfuse.observation.usage_details'] = {k: event[src] for k, src in [('input', 'prompt_tokens'), ('output', 'completion_tokens'), ('total', 'total_tokens')] if isinstance(event.get(src), (int, float))}
            captured_at = record['finished_at'] or stamp
            spans.append({'traceId': trace, 'spanId': stable(f'{run_id}:model:{turn_index}:{index}', 16),
                'parentSpanId': turn_ids.get(turn_index, root_id), 'name': '模型调用证据 · ' + event['model_name'], 'kind': 1,
                'startTimeUnixNano': nanos(captured_at), 'endTimeUnixNano': nanos(captured_at), 'attributes': attributes(values)})
    otlp = {'resourceSpans': [{'resource': {'attributes': attributes({'service.name': 'agent-evo-local', 'service.version': PROTOCOL})},
                              'scopeSpans': [{'scope': {'name': 'agent-evo'}, 'spans': spans}]}]}
    scores = []
    for v in record['verdicts']:
        score_id = stable(v['verdict_id'])
        scores.append({'id': str(UUID(stable('score-event:' + v['verdict_id']), version=4)), 'type': 'score-create', 'timestamp': v['created_at'],
            'body': {'id': score_id, 'traceId': trace, 'observationId': root_id,
                'name': v['dimension'] + ':' + v['evaluator'], 'value': v['result'], 'dataType': 'CATEGORICAL',
                'comment': v['rationale'], 'environment': 'evo-local',
                'metadata': {'evaluator': v['evaluator'], 'critical': bool(v['critical']), 'evidence': v['evidence'], 'original_timestamp': v['created_at']}}})
    return revision, {'otlp': otlp, 'scores': scores, 'trace_id': trace, 'root_id': root_id,
        'span_ids': [s['spanId'] for s in spans], 'score_ids': [s['body']['id'] for s in scores],
        'from_time': (datetime.fromisoformat(stamp) - timedelta(seconds=1)).isoformat(),
        'to_time': (datetime.fromisoformat(record['finished_at'] or stamp) + timedelta(days=1)).isoformat()}


def queue_export(store, run_id):
    with store.connect() as db:
        # Freeze evidence and the durable export in one writer transaction. Recovery
        # also scans opted-in terminal runs, closing a crash before this transaction.
        db.execute('BEGIN IMMEDIATE')
        export = db.execute('SELECT * FROM sync_exports WHERE run_id=? AND enabled=1', (run_id,)).fetchone()
        if not export:
            return
        record = snapshot(store, run_id)
        if record['status'] not in TERMINAL or record['script'] and record['script']['process_status'] in {'queued', 'running'}:
            return
        revision, payload = export_payload(record)
        if export['revision'] == revision:
            db.execute('UPDATE sync_exports SET dirty=0 WHERE run_id=?', (run_id,))
            return
        state = 'pending' if len(dumps(payload).encode()) <= 4 * 1024 * 1024 else 'needs_action'
        # Oversize exports remain local and explicitly incomplete, never silently truncated.
        identifier = stable(run_id + revision)
        db.execute("UPDATE sync_outbox SET state='superseded' WHERE run_id=? AND kind='record' AND state NOT IN ('verified','superseded')", (run_id,))
        db.execute('INSERT OR IGNORE INTO sync_outbox(item_id,run_id,revision,kind,payload_json,created_at,state,last_error) VALUES(?,?,?,?,?,?,?,?)',
            (identifier, run_id, revision, 'record', dumps(payload), now(), state, 'payload_exceeds_4_mib' if state == 'needs_action' else None))
        db.execute('UPDATE sync_exports SET revision=?,updated_at=?,dirty=0 WHERE run_id=?', (revision, now(), run_id))


def queue_batch_controls(store):
    """Separate control traces: never experiment items or counted model calls."""
    with store.connect() as db:
        batches = db.execute('SELECT DISTINCT r.batch_id FROM sync_exports e JOIN runs r USING(run_id) WHERE e.enabled=1').fetchall()
    for batch in batches:
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = db.execute('SELECT r.run_id,r.status,r.started_at,r.finished_at,s.process_status,s.evaluator_status FROM runs r JOIN sync_exports e USING(run_id) LEFT JOIN script_runs s USING(run_id) WHERE r.batch_id=? AND e.enabled=1 ORDER BY r.rowid', (batch['batch_id'],)).fetchall()
            if not rows:
                continue
            info = db.execute('SELECT label,created_at,deleted_at FROM batches WHERE batch_id=?', (batch['batch_id'],)).fetchone()
            control = redact({'batch_id': batch['batch_id'], 'label': info['label'], 'created_at': info['created_at'],
                'archived': bool(info['deleted_at']), 'runs': [dict(r) for r in rows], 'control_only': True})
            active = any(r['status'] in {'running', 'queued'} or r['process_status'] in {'running', 'queued'} for r in rows)
            heartbeat = db.execute('SELECT seen_at FROM worker_state WHERE singleton=1').fetchone()
            if active and heartbeat and heartbeat['seen_at']:
                seen = datetime.fromisoformat(heartbeat['seen_at'])
                control['last_seen_at'] = seen.replace(second=seen.second // 30 * 30, microsecond=0).isoformat()
            control['active_at_last_update'] = active
            revision = stable(dumps(control), 64)
            identifier = stable('batch-control:' + batch['batch_id'] + revision)
            if db.execute('SELECT 1 FROM sync_outbox WHERE item_id=?', (identifier,)).fetchone():
                continue
            trace_id, span_id = stable('batch:' + batch['batch_id']), stable('batch-root:' + batch['batch_id'], 16)
            stamp = max([info['created_at']] + [r['finished_at'] or r['started_at'] or info['created_at'] for r in rows])
            span = {'traceId': trace_id, 'spanId': span_id, 'name': 'EVO 批次进度', 'kind': 1,
                'startTimeUnixNano': nanos(info['created_at']), 'endTimeUnixNano': nanos(stamp),
                'attributes': attributes({'langfuse.observation.type': 'span', 'langfuse.environment': 'evo-control',
                    'langfuse.trace.public': False, 'langfuse.observation.output': dumps(control),
                    'langfuse.observation.metadata.evo_batch_control': dumps(control),
                    'langfuse.observation.metadata.evo_revision': revision})}
            payload = {'control': True, 'otlp': {'resourceSpans': [{'resource': {'attributes': attributes({'service.name': 'agent-evo-control'})}, 'scopeSpans': [{'spans': [span]}]}]},
                'scores': [], 'score_ids': [], 'span_ids': [span_id], 'root_id': span_id, 'trace_id': trace_id,
                'from_time': (datetime.fromisoformat(info['created_at']) - timedelta(seconds=1)).isoformat(),
                'to_time': (datetime.fromisoformat(stamp) + timedelta(days=1)).isoformat()}
            db.execute("UPDATE sync_outbox SET state='superseded' WHERE kind=? AND state NOT IN ('verified','superseded')", ('batch_control:' + batch['batch_id'],))
            db.execute('INSERT INTO sync_outbox(item_id,run_id,revision,kind,payload_json,created_at) VALUES(?,?,?,?,?,?)',
                (identifier, rows[0]['run_id'], revision, 'batch_control:' + batch['batch_id'], dumps(payload), now()))


@dataclass(repr=False)
class Connection:
    host: str
    public_key: str
    secret_key: str
    project_id: str

    def __post_init__(self):
        parsed = urlsplit(self.host)
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'', '/'}:
            raise ValueError('Langfuse 地址应为服务根地址')
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in {'127.0.0.1', 'localhost'}):
            raise ValueError('远程 Langfuse 必须使用 HTTPS；本机自建可用 HTTP')
        self.host = self.host.rstrip('/')

    def request(self, method, path, **kwargs):
        with httpx.Client(base_url=self.host, auth=(self.public_key, self.secret_key), timeout=25, trust_env=False, follow_redirects=False) as client:
            result = client.request(method, '/api/public' + path, **kwargs)
            result.raise_for_status()
            if not result.content and method == 'POST':
                return {}
            return result.json()

    def check(self):
        projects = self.request('GET', '/projects')['data']
        if self.project_id not in {p['id'] for p in projects}:
            raise ValueError('项目 ID 与这组凭证不匹配')

    def observations(self, **params):
        rows = []
        for _ in range(100):
            response = self.request('GET', '/v2/observations', params={**params, 'limit': 1000,
                'fields': 'core,basic,io,metadata', 'expandMetadata': 'evo_record,evo_revision,evo_batch_control'})
            rows.extend(response['data'])
            cursor = response.get('meta', {}).get('cursor')
            if not cursor:
                return rows
            params['cursor'] = cursor
        raise ValueError('超过读取分页上限，请缩小时间范围')


def verify_remote(connection, payload, revision):
    observations = connection.observations(traceId=payload['trace_id'], fromStartTime=payload['from_time'], toStartTime=payload['to_time'])
    by_id = {r['id']: r for r in observations}
    root = by_id.get(payload['root_id'], {})
    metadata = root.get('metadata') or {}
    stored_record = metadata.get('evo_batch_control' if payload.get('control') else 'evo_record')
    if isinstance(stored_record, str):
        stored_record = json.loads(stored_record)
    intact = bool(stored_record and stable(dumps(stored_record), 64) == revision and metadata.get('evo_revision') == revision)
    scores = []
    for offset in range(0, len(payload['score_ids']), 100):
        params = {'id': ','.join(payload['score_ids'][offset:offset+100]), 'limit': 100, 'fields': 'details,subject'}
        for _ in range(100):
            page = connection.request('GET', '/v3/scores', params=params)
            scores.extend(page['data'])
            if not page.get('meta', {}).get('cursor'):
                break
            params['cursor'] = page['meta']['cursor']
        else:
            raise ValueError('score_pagination_limit')
    scores_by_id = {s['id']: s for s in scores}
    mismatches = []
    for span in payload['otlp']['resourceSpans'][0]['scopeSpans'][0]['spans']:
        if span['spanId'] not in by_id:
            continue
        expected = next(a['value']['stringValue'] for a in span['attributes'] if a['key'] == 'langfuse.observation.output')
        actual = by_id[span['spanId']].get('output')
        if isinstance(actual, str):
            try:
                actual = json.loads(actual)
            except ValueError:
                pass
        if dumps(actual) != dumps(json.loads(expected)):
            mismatches.append(span['spanId'])
    for event in payload['scores']:
        expected = event['body']
        actual = scores_by_id.get(expected['id'])
        if not actual:
            continue
        if actual.get('name') != expected['name'] or actual.get('value') != expected['value'] or actual.get('comment') != expected['comment']:
            mismatches.append(expected['id'])
        actual_date = datetime.fromisoformat(actual['timestamp'].replace('Z', '+00:00')).astimezone(timezone.utc).date() if actual.get('timestamp') else None
        expected_date = datetime.fromisoformat(event['timestamp']).astimezone(timezone.utc).date()
        if actual_date != expected_date:
            mismatches.append(expected['id'])
    missing = {'observations': sorted(set(payload['span_ids']) - by_id.keys()),
               'scores': sorted(set(payload['score_ids']) - scores_by_id.keys()), 'record_integrity': not intact, 'payload_mismatch': mismatches}
    return not any(missing.values()), missing


class SyncWorker:
    def __init__(self, store):
        self.store = store
        self.connection = None
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self.loop, name='evo-langfuse-sync', daemon=True)
        if all(os.getenv(k) for k in ('LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_PROJECT_ID')):
            self.connection = Connection(os.getenv('LANGFUSE_BASE_URL', 'https://cloud.langfuse.com'),
                os.environ['LANGFUSE_PUBLIC_KEY'], os.environ['LANGFUSE_SECRET_KEY'], os.environ['LANGFUSE_PROJECT_ID'])

    def start(self):
        # A crash during send has an unknown outcome; stable IDs make the retry safe.
        with self.store.connect() as db:
            db.execute("UPDATE sync_outbox SET state='pending' WHERE state='sending'")
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=2)

    def loop(self):
        import logging
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception as exc:
                logging.getLogger(__name__).warning('Sync worker paused this cycle: %s', type(exc).__name__)
            self.stop_event.wait(3)

    def tick(self):
        with self.store.connect() as db:
            rows = db.execute("SELECT e.run_id FROM sync_exports e JOIN runs r USING(run_id) LEFT JOIN script_runs s USING(run_id) WHERE e.enabled=1 AND e.dirty=1 AND r.status NOT IN ('queued','running') AND (s.process_status IS NULL OR s.process_status NOT IN ('queued','running'))").fetchall()
        for row in rows:
            queue_export(self.store, row['run_id'])
        queue_batch_controls(self.store)
        connection = self.connection
        if not connection or os.getenv('EVO_LANGFUSE_SYNC_ENABLED', '1').lower() in {'0', 'false'}:
            return
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute("SELECT o.*,e.destination FROM sync_outbox o JOIN sync_exports e USING(run_id) WHERE e.enabled=1 AND o.state IN ('pending','indexing','partial') AND o.next_attempt<=? ORDER BY o.created_at LIMIT 1", (time.time(),)).fetchone()
            if not row:
                return
            db.execute("UPDATE sync_outbox SET state='sending',attempts=attempts+1 WHERE item_id=?", (row['item_id'],))
        payload = json.loads(row['payload_json'])
        state, error, delay, ack = 'indexing', None, 5, row['acknowledged_at']
        # Bind the durable queue to its first destination, including region.
        destination = connection.host + '/' + connection.project_id
        if row['destination'] and row['destination'] != destination:
            state, error = 'needs_action', 'destination_changed'
        else:
            payload['destination'] = destination
            with self.store.connect() as db:
                db.execute('UPDATE sync_exports SET destination=? WHERE run_id=? AND destination IS NULL', (destination, row['run_id']))
                db.execute('UPDATE sync_outbox SET payload_json=? WHERE item_id=?', (dumps(payload), row['item_id']))
            try:
                if not ack:
                    result = connection.request('POST', '/otel/v1/traces', json=payload['otlp'], headers={'x-langfuse-ingestion-version': '4'})
                    if int(result.get('partialSuccess', {}).get('rejectedSpans', 0)):
                        raise ValueError('otel_partial_rejection')
                    for score in payload['scores']:
                        # REST /scores does not expose timestamp. Score-only ingestion
                        # retains client timestamps and remains supported in v4.
                        result = connection.request('POST', '/ingestion', json={'batch': [score]})
                        if result.get('errors'):
                            raise ValueError('score_rejected')
                    ack = now()
                verified, missing = verify_remote(connection, payload, row['revision'])
                if verified:
                    state = 'verified'
                else:
                    state, error = 'partial' if len(missing['observations']) < len(payload['span_ids']) else 'indexing', dumps(missing)
                    delay = 60 if (datetime.now(timezone.utc) - datetime.fromisoformat(ack)).total_seconds() > 120 else 5
            except httpx.HTTPStatusError as exc:
                code = exc.response.status_code
                error = f'langfuse_http_{code}'
                state = ('indexing' if ack else 'pending') if code == 429 or code >= 500 else 'needs_action'
                delay = min(300, 2 ** min(row['attempts'] + 1, 8))
                retry = exc.response.headers.get('retry-after', '')
                if retry.isdigit():
                    delay = max(delay, min(int(retry), 3600))
                elif retry:
                    try:
                        delay = max(delay, min(3600, (parsedate_to_datetime(retry) - datetime.now(timezone.utc)).total_seconds()))
                    except (ValueError, TypeError):
                        pass
            except httpx.HTTPError:
                state, error, delay = ('indexing' if ack else 'pending'), 'connection_unavailable', min(300, 2 ** min(row['attempts'] + 1, 8))
            except (ValueError, KeyError, TypeError):
                state, error = 'needs_action', 'protocol_or_payload_error'
        with self.store.connect() as db:
            db.execute('UPDATE sync_outbox SET state=?,last_error=?,next_attempt=?,acknowledged_at=? WHERE item_id=?',
                (state, error, time.time() + delay, ack, row['item_id']))
