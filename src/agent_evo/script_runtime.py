from __future__ import annotations

import os
import json
import subprocess
import time
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

from agent_evo.script_store import binding, get_script, update_binding, verify_script
from agent_evo.store import dumps, now


def inspect_interpreter(interpreter, requirements=()):
    # On POSIX a venv's python is usually a symlink. Resolving it launches the
    # base interpreter without the selected environment's installed dependencies.
    path = Path(interpreter).absolute()
    if not path.is_file() or not path.name.lower().startswith('python'):
        raise ValueError('请选择本机 Python 解释器的绝对路径')
    try:
        probe = subprocess.run([str(path), '-I', '-c',
            'import sys, json, importlib.metadata as m; import agent_evo; '
            'print(json.dumps({"python":str(sys.version_info.major)+"."+str(sys.version_info.minor),"version":sys.version,'
            '"dependencies":{name:m.version(name) for name in json.loads(sys.argv[1])}}))', json.dumps(list(requirements))],
            capture_output=True, text=True, timeout=10, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError('解释器启动失败或检查超时') from None
    if probe.returncode:
        raise ValueError('解释器须为 Python 3.12–3.14，且已安装本项目及依赖；导入不会自动安装依赖')
    environment = json.loads(probe.stdout)
    if environment['python'] not in {'3.12', '3.13', '3.14'}:
        raise ValueError('解释器须为 Python 3.12–3.14')
    return str(path), environment


def execute_script(run, store, settings, *, rescore=False, stop_event=None):
    run_id = run['run_id']
    contract = binding(store, run_id)
    process = None
    reason = None
    try:
        script = get_script(store, contract['script_id'])
        directory = verify_script(store, script)
        interpreter, environment_version = inspect_interpreter(contract['interpreter'], script['manifest'].get('requirements', []))
        update_binding(store, run_id, process_status='running')
        store.add_event(run_id, 'platform', 'script.start', 'running', {'script_sha256': script['sha256'], 'script_name': script['name'], 'environment': environment_version, 'protocol': 1, 'rescore': rescore})
        log_path = settings.artifact_root / run_id / ('script-' + uuid4().hex + '.log')
        log_path.parent.mkdir(parents=True, exist_ok=True)
        # Credentials travel through a pipe, never argv or an on-disk request file.
        environment = {k: v for k, v in os.environ.items() if k.upper() in {
            'SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA',
            'DASHSCOPE_API_KEY', 'EVO_CONTEXT_JUDGE_ENABLED', 'EVO_CONTEXT_JUDGE_BASE_URL', 'EVO_CONTEXT_JUDGE_MODEL'}}
        environment['PYTHONDONTWRITEBYTECODE'] = '1'
        with log_path.open('wb') as log:
            process = subprocess.Popen([interpreter, '-I', '-B', '-X', 'utf8', str(Path(__file__).with_name('script_host.py'))],
                stdin=subprocess.PIPE, stdout=log, stderr=log, cwd=contract.get('working_directory') or directory, env=environment,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            request = dumps({'settings': asdict(settings), 'run_id': run_id, 'script': script, 'rescore': rescore, 'parent_pid': os.getpid()})
            process.stdin.write(request.encode('utf-8'))
            process.stdin.close()
            deadline = time.monotonic() + contract['timeout_seconds']
            heartbeat_at = 0
            while process.poll() is None:
                if stop_event and stop_event.is_set():
                    reason = 'platform_stopped_result_unknown'
                    break
                if time.monotonic() - heartbeat_at > 5 and run.get('worker_id'):
                    store.heartbeat(run['worker_id'])
                    heartbeat_at = time.monotonic()
                if binding(store, run_id)['cancel_requested']:
                    reason = 'script_cancelled_result_unknown'
                    break
                if time.monotonic() >= deadline:
                    reason = 'script_timeout_result_unknown'
                    break
                if log_path.stat().st_size > 10 * 1024 * 1024:
                    reason = 'script_log_limit'
                    break
                time.sleep(.2)
            if reason:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
            elif process.returncode:
                reason = 'script_process_failed'
        if reason:
            latest = store.get_run(run_id)
            # Business output already persisted is evidence, even when the script fails later.
            if latest['status'] in {'queued', 'running'}:
                store.set_run_fields(run_id, status='blocked', error_code=reason, finished_at=now())
            update_binding(store, run_id, evaluator_status='interrupted' if 'unknown' in reason else 'failed')
        update_binding(store, run_id, process_status='interrupted' if reason else 'completed')
        store.add_event(run_id, 'platform', 'script.finish', 'failed' if reason else 'completed',
                        {'error_code': reason, 'business_output_preserved': True,
                         'local_log': log_path.name, 'backend_request_may_continue': bool(reason and 'unknown' in reason)})
    except Exception as exc:
        if process and process.poll() is None:
            process.kill()
            process.wait(timeout=3)
        store.set_run_fields(run_id, status='blocked', error_code='script_setup_failed', finished_at=now())
        update_binding(store, run_id, process_status='failed', evaluator_status='failed')
        store.add_event(run_id, 'platform', 'script.setup', 'failed', {'error_type': type(exc).__name__, 'message': str(exc)})
