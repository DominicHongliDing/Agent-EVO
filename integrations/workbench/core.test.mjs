import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localDatabase} from './local-server.mjs';
import {workbench} from './core.mjs';
import {generateCases} from './generation.mjs';
import {compareJobs} from './analysis.mjs';
import {canonicalizeCitations} from '../../web/src/answerReview.mjs';
import {prepareTraceSync,sendTraceSync} from './trace-sync.mjs';
test('version comparison retains unknown and different versions; cosmetic citations never alter facts',()=>{
 const unit={id:'a',title:'correction',question_key:'v1|c1',dimensions:{context:3,coverage:4},execution:'completed',quality:'pass',rubric:'r1',judge_model:'m1',profile:'answers-multi',review_status:'confirmed',source:{version_matches:true},critical:[]};
 const baseline={project_id:'p',connection:'c',units:[unit]},current={...baseline,units:[{...unit,id:'b',dimensions:{context:5,coverage:5}},{...unit,id:'new',question_key:'v1|c2'}]};
 assert.deepEqual(compareJobs(current,baseline).counts,{improved:1,regressed:0,same:0,incomparable:1});
 assert.equal(compareJobs({...current,units:[{...unit,source:{version_matches:false}}]},baseline).counts.incomparable,1);
 const record={turns:[{turn:1,answer:'目前状态为**已发货**，请联系售后。'}]};
 const data={turns:[{dimensions:[{evidence:[{ref:'turn:1:assistant',quote:'状态为已发货'}]}]}]};
 const repaired=canonicalizeCitations(data,record);assert.equal(repaired.repairs.length,1);assert.ok(record.turns[0].answer.includes(data.turns[0].dimensions[0].evidence[0].quote));
 const wrong={critical_findings:[{evidence:[{ref:'turn:1:assistant',quote:'状态为未发货'}]}]};assert.equal(canonicalizeCitations(wrong,record).repairs.length,0);
});
test('trace target success requires matching readback, not an ingestion acknowledgement',async()=>{
 const attempt={id:'a',case_id:'c',created:'2026-10-13T00:00:00Z',input:{turns:[{message:'Hi'}]},result:{conversation_id:'s',turns:[{question:'Hi',answer:'Hello'}]}};
 const unit={title:'Hi',dimensions:{coverage:5},rubric:'r1'},job={id:'j',name:'test',dataset_version:'v1',agent_version:'a1'};
 const p=await prepareTraceSync(attempt,unit,job);
 const config={host:'https://cloud.langfuse.com',public_key:'fixture',secret_key:'fixture'};
 const pending=await sendTraceSync(p,config,false,async()=>Response.json({data:[]}));assert.equal(pending.status,'indexing');
 const good=async url=>Response.json(url.includes('observations')?{data:p.otlp.resourceSpans[0].scopeSpans[0].spans.map(s=>({id:s.spanId,output:JSON.parse(s.attributes.find(a=>a.key==='langfuse.observation.output').value.stringValue)}))}:url.includes('/scores')?{data:p.scores.map(s=>s.body)}:{});
 assert.equal((await sendTraceSync(p,config,false,good)).status,'verified');
 await assert.rejects(()=>sendTraceSync(p,{...config,host:'http://169.254.169.254'},false,good),/公共站点/);
});
test('projects isolate data; connector strips expectations; cancellation and uploads are durable/idempotent',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'evo-hub-'));let db=localDatabase(join(dir,'test.db'));
 async function call(path,data,owner='alice',token,method){const r=await workbench(new Request('https://evo.test/api/workbench'+path,{method:method||(data?'POST':'GET'),headers:{'X-EVO-Workbench':'1',...(owner?{'oai-authenticated-user-id':owner}:{}),...(token?{Authorization:'Bearer '+token}:{})},body:data?JSON.stringify(data):undefined}),{DB:db});return {status:r.status,...await r.json()}}
 try{
 assert.equal((await call('/projects',undefined,null)).status,401);
 const p=await call('/projects',{name:'Meeting helper'}),base='/projects/'+p.id;
 assert.equal((await call(base+'/jobs',undefined,'bob')).status,404);
 const c=await call(base+'/connections',{name:'Local Python',kind:'python'});
 const d=await call(base+'/datasets',{name:'Corrections',cases:[{case_id:'c1',turns:[{message:'周三见'},{message:'改成周四，请确认'}],expected:{secret_gold:'周四'},reference:'private gold',review_status:'confirmed'}]});
 const j=await call(base+'/jobs',{dataset:d.id,connection:c.id,agent_version:'v1',repeats:2});assert.equal(j.planned,2);
 const grant=await call(base+'/tokens',{connection:c.id});assert.ok(grant.token);
 assert.equal((await call(base+'/tokens',undefined,'bob')).status,404);
 const claim=await call('/runner/claim',{},null,grant.token);const a=claim.attempt;assert.ok(a);assert.ok(!JSON.stringify(a).includes('private gold'));assert.ok(!JSON.stringify(a).includes('secret_gold'));
 const second=await call('/runner/claim',{},null,grant.token);assert.notEqual(second.attempt.attempt_id,a.attempt_id);
 const result={status:'completed',conversation_id:'actual-c1',agent_version:'v1',turns:[{question:'周三见',answer:'已记录周三'},{question:'改成周四，请确认',answer:'已经更正为周四'}]};
 assert.equal((await call('/runner/result',{attempt_id:a.attempt_id,lease:'wrong',result},null,grant.token)).status,409);
 assert.equal((await call('/runner/result',{attempt_id:a.attempt_id,lease:a.lease,result},null,grant.token)).accepted,true);
 assert.equal((await call('/runner/result',{attempt_id:a.attempt_id,lease:a.lease,result},null,grant.token)).reused,true);
 assert.equal((await call('/runner/result',{attempt_id:a.attempt_id,lease:a.lease,result:{...result,agent_version:'other'}},null,grant.token)).status,409);
 await call(base+'/jobs/'+j.id+'/cancel',{});
 assert.equal((await call('/runner/result',{attempt_id:second.attempt.attempt_id,lease:second.attempt.lease,result},null,grant.token)).status,409);
 db.close();db=localDatabase(join(dir,'test.db'));const saved=await call(base+'/jobs/'+j.id);assert.deepEqual(saved.attempts.map(a=>a.status).sort(),['completed','uncertain']);
 const bundle=await call(base+'/jobs/'+j.id+'/bundle');assert.ok(!JSON.stringify(bundle).includes('private gold'));
 const offlineJob=await call(base+'/jobs',{dataset:d.id,connection:c.id,agent_version:'v1',repeats:1});
 const offlineBundle=await call(base+'/jobs/'+offlineJob.id+'/bundle');const oa=offlineBundle.attempts[0];
 const packet={schema:'evo-offline-results-v1',project_id:p.id,job_id:offlineJob.id,dataset_version:offlineJob.dataset_version,results:[{attempt_id:oa.attempt_id,case_id:oa.case_id,repeat:oa.repeat,result}]};
 assert.equal((await call(base+'/jobs/'+offlineJob.id+'/offline',{...packet,dataset_version:'wrong'})).status,422);
 assert.equal((await call(base+'/jobs/'+offlineJob.id+'/offline',packet)).accepted,1);
 assert.equal((await call(base+'/jobs/'+offlineJob.id+'/offline',packet)).accepted,0);
 const exported=await call(base+'/jobs/'+offlineJob.id+'/export');assert.equal(exported.records[0].source,'offline_uploaded_unverified');assert.equal(exported.records[0].evidence_verified,false);
 const conflict={...packet,results:[{...packet.results[0],result:{...result,agent_version:'changed'}}]};
 assert.equal((await call(base+'/jobs/'+offlineJob.id+'/offline',conflict)).status,409);

 await call(base+'/tokens/'+grant.id,undefined,'alice',undefined,'DELETE');assert.equal((await call('/runner/claim',{},null,grant.token)).status,401);
 }finally{db.close();rmSync(dir,{recursive:true})}
});
test('generation refuses invented references, keeps expectations drafts, uses an independent stage',async()=>{
 const input={description:'帮助客户整理会议时间并确认时间更正',count:1,references:'周四见',exclude:[]};
 const response=ref=>async()=>Response.json({id:'fixture-only',usage:{total_tokens:12},choices:[{message:{content:JSON.stringify({cases:[{turns:[{message:'请记录周四的会议。'}],expectation:'确认用户给出的时间',reference_quote:ref}]})}}]});
 const missing=await generateCases(input,'fixture-not-a-key',response('凭空引用'));assert.equal(missing.cases[0].review_status,'needs_reference');assert.equal(missing.cases[0].reference,'');assert.match(missing.cases[0].expected.attention,/无法逐字核对/);
 const valid=await generateCases(input,'fixture-not-a-key',response('周四见'));assert.equal(valid.cases[0].review_status,'draft');assert.equal(valid.generation.stage,'test_generation');assert.equal(valid.generation.business_calls,0);
 const duplicate=await generateCases({...input,exclude:['请记录周四的会议。']},'fixture-not-a-key',response('周四见'));assert.equal(duplicate.cases.length,0);assert.match(duplicate.generation.issues[0],/重复/);
});
