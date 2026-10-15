"""Trusted local script subprocess. This is process isolation, not a security sandbox."""
from __future__ import annotations

import copy
import importlib.util
import json
import os
import sys
import threading
import time
from pathlib import Path

from agent_evo.config import Settings
from agent_evo.runner import execute_business
from agent_evo.script_store import update_binding, verify_script
from agent_evo.store import Store


class Context:
    def __init__(self, store, run, rescore=False):
        self._store = store
        self._run = run
        self.called = False
        self.rescore = rescore

    def call_agent(self):
        """Run the frozen case once, including every turn in its original order."""
        if self.called:
            raise ValueError('每条用例只允许一次 call_agent；多轮对话由平台保持同一业务会话')
        if self.rescore:
            raise ValueError('重新评分模式不允许调用 Agent')
        self.called = True
        execute_business(self._run, self._store, self._store.settings)
        return copy.deepcopy(self._store.get_run(self._run['run_id'])['output'])


def main():
    request = json.loads(sys.stdin.buffer.read())
    parent_pid = request['parent_pid']
    def watch_parent(watched_pid):
        if os.name == 'nt':
            import ctypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_uint32]
            kernel.OpenProcess.restype = ctypes.c_void_p
            kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            kernel.WaitForSingleObject.restype = ctypes.c_uint32
            handle = kernel.OpenProcess(0x00100000, False, watched_pid)
            if not handle:
                os._exit(75)
            kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
            os._exit(75)
        while os.getppid() == watched_pid:
            time.sleep(.5)
        os._exit(75)
    # Windows venv launchers can be a separate process. Watch both the launcher
    # (cancel/timeout) and platform (crash), so neither leaves the host orphaned.
    for watched_pid in {parent_pid, os.getppid()}:
        threading.Thread(target=watch_parent, args=(watched_pid,), name='evo-parent-watch', daemon=True).start()
    settings = request['settings']
    for key in ('db_path', 'artifact_root', 'dataset_root', 'fixture_root', 'unihr_usage_db', 'unihr_source', 'clinical_source'):
        if settings[key] is not None:
            settings[key] = Path(settings[key])
    store = Store(Settings(**settings))
    run = store.get_run(request['run_id'])
    directory = verify_script(store, request['script'])
    entry = directory / request['script']['manifest']['entrypoint']
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location('evo_user_evaluation', entry)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    context = Context(store, run, request.get('rescore', False))
    case = store.get_case(run['case_id'])
    first_event = max((e['seq'] for e in store.events(run['run_id'])), default=0)
    if context.rescore:
        from agent_evo.evaluation import evaluate_run
        evaluate_run(store, run['run_id'])
    else:
        module.run_case(copy.deepcopy(case), context)
        if not context.called:
            raise ValueError('脚本没有调用 context.call_agent()，不构成真实业务评测')
    try:
        if hasattr(module, 'evaluate_case'):
            # The script's run_case return cannot replace authoritative business evidence.
            verdicts = module.evaluate_case(copy.deepcopy(case), copy.deepcopy(store.get_run(run['run_id'])['output']), context)
            if not isinstance(verdicts, list) or len(verdicts) > 100:
                raise ValueError('evaluate_case 必须返回最多 100 项评分列表')
            for v in verdicts:
                if not isinstance(v, dict) or v.get('result') not in {'pass', 'fail', 'unjudged'} or not isinstance(v.get('dimension'), str) or not isinstance(v.get('rationale'), str):
                    raise ValueError('评分须包含 dimension、result 和 rationale')
                if not isinstance(v.get('evidence', []), list) or any(not isinstance(e, str) for e in v.get('evidence', [])):
                    raise ValueError('evidence 必须为证据引用字符串列表')
            for v in verdicts:
                store.add_verdict(run['run_id'], 'custom.' + v['dimension'][:100],
                    'script:' + request['script']['sha256'], v['result'], v['rationale'], v.get('evidence', []), bool(v.get('critical')))
        failed = any(e['kind'] == 'evaluation' and e['status'] == 'failed' for e in store.events(run['run_id'], first_event))
        update_binding(store, run['run_id'], evaluator_status='failed' if failed else 'completed')
    except Exception as exc:
        update_binding(store, run['run_id'], evaluator_status='failed')
        store.add_event(run['run_id'], 'evaluation', 'script.evaluate', 'failed',
                        {'error_type': type(exc).__name__, 'business_output_preserved': True})
        raise


if __name__ == '__main__':
    main()
