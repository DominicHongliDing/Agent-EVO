"""Customer-side connector. Python 3.10+, standard library only.
Set EVO_CONNECTOR_TOKEN, optionally EVO_AGENT_TOKEN / EVO_PLATFORM_TOKEN.
python evo_connector.py --platform https://your.site --url http://localhost:8001/chat --version v1
Or --adapter my_agent:run_turn. Scripts and Agent credentials stay on this computer.
"""
import argparse
import hashlib
import importlib
import json
import os
import sqlite3
import threading
import time
import urllib.request
import urllib.error
import uuid
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, payload, headers, timeout=90):
    data = json.dumps(payload, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json', **headers})
    with urllib.request.build_opener(NoRedirect).open(req, timeout=timeout) as response:
        value = response.read(2*1024*1024+1)
        if len(value) > 2*1024*1024:
            raise ValueError('Response exceeds 2 MiB')
        return json.loads(value)


def field(value, path):
    for key in path.split('.'):
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def http_adapter(url, answer_path, session_path):
    def run_turn(message, conversation_id, history, turn_index):
        token = os.getenv('EVO_AGENT_TOKEN', '')
        result = request(url, {'message': message, 'conversation_id': conversation_id,
                         'history': history, 'turn_index': turn_index},
                         {'Authorization': 'Bearer '+token} if token else {})
        return {'answer': field(result, answer_path), 'conversation_id': field(result, session_path) or conversation_id,
                'steps': result.get('steps', []), 'usage': result.get('usage'), 'versions': result.get('versions')}
    return run_turn


def execute(item, adapter, version, cancelled=None):
    conversation = 'evo_'+uuid.uuid4().hex
    history, turns = [], []
    started = time.monotonic()
    try:
        for i, turn in enumerate(item['input']['turns'], 1):
            if cancelled and cancelled():
                raise RuntimeError('Execution lease lost; remaining turns cancelled')
            branch = turn.get('branch')
            message = branch['message'] if branch and branch['contains'] in (turns[-1]['answer'] if turns else '') else turn['message']
            result = adapter(message=message, conversation_id=conversation, history=history.copy(), turn_index=i)
            if not isinstance(result, dict) or not isinstance(result.get('answer'), str) or not result['answer'].strip():
                raise ValueError('Adapter must return a non-empty answer')
            conversation = result.get('conversation_id') or conversation
            # Default data policy: question/answer only. Steps need an explicit local opt-in.
            turns.append({'question': message, 'answer': result['answer'],
                          'steps': result.get('steps', []) if os.getenv('EVO_INCLUDE_STEPS') == '1' else [],
                          'usage': result.get('usage'), 'versions': result.get('versions')})
            history.extend([{'role': 'user', 'content': message}, {'role': 'assistant', 'content': result['answer']}])
        status, error = 'completed', None
    except Exception as exc:
        # Timeout may mean the business action happened. Never automatically repeat it.
        status, error = 'uncertain', type(exc).__name__+': check the Agent locally; no automatic replay'
    return {'status': status, 'turns': turns, 'conversation_id': conversation, 'agent_version': version,
            'duration_ms': round((time.monotonic()-started)*1000), 'error': error,
            'evidence_policy': 'questions_answers_steps' if os.getenv('EVO_INCLUDE_STEPS') == '1' else 'questions_answers',
            'usage_source': 'agent_reported_unverified'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform')
    parser.add_argument('--url')
    parser.add_argument('--adapter', help='Trusted local Python module:function')
    parser.add_argument('--version', required=True)
    parser.add_argument('--answer-path', default='answer')
    parser.add_argument('--session-path', default='conversation_id')
    parser.add_argument('--state', default='.evo-connector.sqlite')
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--bundle', help='Run an offline input bundle instead of claiming online tasks')
    parser.add_argument('--output', default='evo-results.json')
    args = parser.parse_args()
    if args.adapter:
        module, name = args.adapter.split(':', 1)
        adapter = getattr(importlib.import_module(module), name)
    elif args.url:
        adapter = http_adapter(args.url, args.answer_path, args.session_path)
    else:
        parser.error('Provide --url or --adapter')
    state = sqlite3.connect(args.state)
    state.execute('CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, item TEXT, result TEXT, uploaded INTEGER DEFAULT 0)')
    def run_once(item, cancelled=None):
        old = state.execute('SELECT result FROM attempts WHERE id=?', (item['attempt_id'],)).fetchone()
        if old:
            if old[0]:
                return json.loads(old[0])
            return {'status': 'uncertain', 'turns': [], 'conversation_id': item['attempt_id'], 'agent_version': args.version,
                    'error': 'Connector stopped during execution. Check the Agent before creating a new attempt.'}
        state.execute('INSERT INTO attempts(id,item) VALUES(?,?)', (item['attempt_id'], json.dumps(item)))
        state.commit()  # Durable before issuing any business request.
        result = execute(item, adapter, args.version, cancelled)
        state.execute('UPDATE attempts SET result=? WHERE id=?', (json.dumps(result, ensure_ascii=False), item['attempt_id']))
        state.commit()
        return result
    if args.bundle:
        bundle = json.loads(Path(args.bundle).read_text(encoding='utf-8-sig'))
        if bundle.get('schema') != 'evo-execution-v1':
            parser.error('Unsupported input bundle')
        results = []
        for item in bundle['attempts']:
            results.append({**{k: item[k] for k in ['attempt_id', 'case_id', 'repeat']},
                            'result': run_once({**item, 'input': {'turns': item['turns']}})})
            Path(args.output).write_text(json.dumps({**{k: bundle[k] for k in ['project_id', 'job_id', 'dataset_version']},
                         'schema': 'evo-offline-results-v1', 'results': results}, ensure_ascii=False, indent=2), encoding='utf-8')
        print('Saved result package. Inspect/deidentify before importing:', args.output)
        return
    if not args.platform or not os.getenv('EVO_CONNECTOR_TOKEN'):
        parser.error('--platform and EVO_CONNECTOR_TOKEN are required')
    headers = {'Authorization': 'Bearer '+os.environ['EVO_CONNECTOR_TOKEN'], 'X-EVO-Workbench': '1'}
    if os.getenv('EVO_PLATFORM_TOKEN'):
        headers['X-EVO-Token'] = os.environ['EVO_PLATFORM_TOKEN']
    def call(path, payload):
        return request(args.platform.rstrip('/')+'/api/workbench/runner/'+path, payload, headers)
    while True:
        # Retry uploads only; never re-execute previously claimed attempts.
        for aid, raw, result in state.execute('SELECT id,item,result FROM attempts WHERE uploaded=0 AND result IS NOT NULL').fetchall():
            item = json.loads(raw)
            if 'lease' not in item:
                continue
            try:
                call('result', {'attempt_id': aid, 'lease': item['lease'], 'result': json.loads(result)})
                state.execute('UPDATE attempts SET uploaded=1 WHERE id=?', (aid,)); state.commit()
            except urllib.error.HTTPError as exc:
                if exc.code in {401, 403, 409}:
                    state.execute('UPDATE attempts SET uploaded=-1 WHERE id=?', (aid,)); state.commit()
                    print('Upload needs manual review; local result retained:', aid)
        item = call('claim', {})['attempt']
        if item:
            stop = threading.Event()
            def heartbeat():
                while not stop.wait(25):
                    try:
                        call('heartbeat', {'attempt_id': item['attempt_id'], 'lease': item['lease']})
                    except Exception:
                        stop.set()
            threading.Thread(target=heartbeat, daemon=True).start()
            try:
                result = run_once(item, stop.is_set)
                call('result', {'attempt_id': item['attempt_id'], 'lease': item['lease'], 'result': result})
                state.execute('UPDATE attempts SET uploaded=1 WHERE id=?', (item['attempt_id'],)); state.commit()
                print('Saved', item['attempt_id'], result['status'])
            finally:
                stop.set()
        if args.once:
            break
        time.sleep(3 if item else 8)


if __name__ == '__main__':
    main()
