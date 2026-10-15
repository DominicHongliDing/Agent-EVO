const upstream = 'https://api.dominicspace.com';
const routes = new Map([
  ['/health',['GET']], ['/providers',['GET']], ['/credentials/validate',['POST']],
  ['/materials/parse',['POST']], ['/knowledge/preview',['POST']], ['/sessions',['POST','DELETE']],
  ['/clinical-tasks',['GET']], ['/clinical-tasks/intake/extract',['POST']], ['/runs',['POST']]
]);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const asset = assets[path];
      if (!asset) return new Response('Not found', {status:404});
      if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed', {status:405});
      return new Response(request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.body), c=>c.charCodeAt(0)), {
        encodeBody: 'manual',
        headers: {'Content-Type':asset.type, 'X-Content-Type-Options':'nosniff', 'Cache-Control':path.endsWith('.html')||path.endsWith('.json')?'no-cache':'private, max-age=3600', ...(asset.encoding?{'Content-Encoding':asset.encoding}:{})}
      });
    }
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return new Response('Forbidden', {status:403});
    const path = url.pathname.slice(4);
    if (path.startsWith('/workbench/')) return workbench(request, env);
    if (path === '/evaluation/judge') return judgeUploadedAnswers(request);
    if (path === '/evaluation/report') return generateEvaluationReport(request);
    const methods = routes.get(path) || (/^\/artifacts\/[a-zA-Z0-9_-]+$/.test(path)?['GET']:[]);
    if (!methods.includes(request.method)) return new Response('Not found', {status:404});
    const headers = new Headers();
    for (const name of ['Content-Type','Authorization']) {
      const value = request.headers.get(name); if (value) headers.set(name,value);
    }
    // Site authentication cookies and identity headers never leave the Site.
    // Model credentials are forwarded per request, never stored or logged.
    let body;
    if (!['GET','HEAD'].includes(request.method)) {
      const reader=request.body?.getReader(); const chunks=[]; let length=0;
      if(reader) while(true) {const part=await reader.read(); if(part.done)break; length+=part.value.length;
        if(length>6*1024*1024){await reader.cancel();return new Response('Payload too large',{status:413});} chunks.push(part.value);}
      body=new Uint8Array(length); let offset=0; for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
    }
    try {
      // workerd rejects redirect:'error' before issuing the request. Never
      // follow redirects with visitor credentials; reject 3xx explicitly.
      const response=await fetch(upstream+path+url.search,{method:request.method,headers,body,redirect:'manual'});
      if(response.status>=300 && response.status<400) return Response.json({detail:'产品服务地址发生跳转，请联系网站管理员。'},{status:502});
      const outgoing=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      for(const name of ['Content-Type','Content-Disposition']){const value=response.headers.get(name);if(value)outgoing.set(name,value);}
      return new Response(response.body,{status:response.status,headers:outgoing});
    } catch { return Response.json({detail:'暂时无法连接现有产品服务，请稍后重试。'},{status:502}); }
  }
};
