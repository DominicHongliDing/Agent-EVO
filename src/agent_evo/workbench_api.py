"""Local proxy to the shared Worker-compatible persistent workbench service."""
import os
import secrets
import shutil
import subprocess
from pathlib import Path
import httpx
from fastapi import HTTPException, Request
from fastapi.responses import Response


class Workbench:
    def __init__(self, settings):
        self.settings = settings
        self.secret = secrets.token_urlsafe(32)
        self.process = None
        self.port = int(os.getenv('EVO_WORKBENCH_PORT', '8198'))

    def start(self):
        node = shutil.which('node')
        if not node:
            return
        root = Path(__file__).resolve().parents[2]
        env = {**os.environ, 'EVO_SIDECAR_TOKEN': self.secret,
               'EVO_WORKBENCH_DB': str(self.settings.db_path.with_name('workbench.db')),
               'EVO_WORKBENCH_PORT': str(self.port)}
        self.process = subprocess.Popen([node, str(root/'integrations/workbench/local-server.mjs'), '--serve'],
            cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()

    def install(self, app, access):
        @app.api_route('/api/workbench/{path:path}', methods=['GET', 'POST', 'DELETE'])
        async def proxy(path: str, request: Request):
            await access(request)
            payload = await request.body()
            if len(payload) > 2*1024*1024:
                raise HTTPException(413, '材料超过 2 MiB')
            headers = {'X-EVO-Sidecar': self.secret}
            for name in ['Content-Type', 'Authorization', 'X-EVO-Workbench']:
                if name in request.headers:
                    headers[name] = request.headers[name]
            try:
                async with httpx.AsyncClient(trust_env=False, timeout=270) as client:
                    result = await client.request(request.method, f'http://127.0.0.1:{self.port}/api/workbench/{path}',
                        headers=headers, content=payload)
                return Response(result.content, result.status_code, media_type='application/json', headers={'Cache-Control': 'no-store'})
            except httpx.HTTPError:
                raise HTTPException(503, '持久任务服务尚未启动，请检查 Node 24+ 与本地端口') from None
