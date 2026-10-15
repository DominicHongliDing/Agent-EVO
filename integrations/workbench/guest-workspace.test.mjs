import {test} from 'node:test';
import assert from 'node:assert/strict';
import {workbench} from './core.mjs';
import {localDatabase} from './local-server.mjs';
test('anonymous browser can persist its project without exposing existing or other browser records',async()=>{
 const db=localDatabase(':memory:');
 const call=async(path,data,workspace='',account='')=>{const r=await workbench(new Request('https://evo.test/api/workbench'+path,{method:data?'POST':'GET',headers:{'X-EVO-Workbench':'1','X-EVO-Workspace':workspace,...(account?{'oai-authenticated-user-id':account}:{})},body:data?JSON.stringify(data):undefined}),{DB:db});return {status:r.status,...await r.json()}};
 try{
 const a='a'.repeat(64),b='b'.repeat(64);
 assert.equal((await call('/session',undefined,a)).guest,true);
 assert.equal((await call('/projects',undefined,'bad')).status,401);
 const existing=await call('/projects',{name:'既有账号'},'','owner');
 const p=await call('/projects',{name:'免登录体验'},a);
 assert.equal(p.status,201);
 assert.deepEqual((await call('/projects',undefined,a)).items.map(x=>x.id),[p.id]);
 assert.equal((await call('/projects',undefined,b)).items.length,0);
 assert.equal((await call('/projects/'+existing.id+'/datasets',undefined,a)).status,404);
 assert.equal((await call('/projects/'+p.id+'/datasets',undefined,b)).status,404);
 assert.equal((await call('/projects/'+p.id+'/datasets',undefined,a)).status,200);
 assert.equal((await call('/projects',undefined,a,'owner')).items[0].id,existing.id);
 }finally{db.close()}
});
