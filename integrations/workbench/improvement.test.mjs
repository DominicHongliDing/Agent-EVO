import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localDatabase} from './local-server.mjs';
import {workbench} from './core.mjs';
import {compareJobs} from './analysis.mjs';

async function fixture(fn){
 const dir=mkdtempSync(join(tmpdir(),'evo-improvement-')),db=localDatabase(join(dir,'test.db'));
 async function call(path,data,token,owner='alice'){const response=await workbench(new Request('https://evo.test/api/workbench'+path,{method:data?'POST':'GET',headers:{'X-EVO-Workbench':'1',...(owner?{'oai-authenticated-user-id':owner}:{}),...(token?{Authorization:'Bearer '+token}:{})},body:data?JSON.stringify(data):undefined}),{DB:db});return {...await response.json(),httpStatus:response.status}}
 try{const p=await call('/projects',{name:'Protocol fixtures (not real model evidence)'}),base='/projects/'+p.id;
 const c=await call(base+'/connections',{name:'Customer agent',kind:'python'});
 const d=await call(base+'/datasets',{name:'Frozen cases',cases:[{case_id:'c1',turns:[{message:'When?'},{message:'Default followup',branch:{contains:'Thursday',message:'Confirm Thursday'}}],expected:{behavior:'Retain Thursday'},reference:'Thursday',review_status:'confirmed'}]});
 const token=(await call(base+'/tokens',{connection:c.id})).token;
 const job=async(extra={})=>call(base+'/jobs',{dataset:d.id,connection:c.id,agent_version:'v1',repeats:1,...extra});
 const result={status:'completed',conversation_id:'fixture-c1',agent_version:'v1',turns:[{question:'When?',answer:'Thursday'},{question:'Confirm Thursday',answer:'Thursday confirmed'}]};
 await fn({db,call,base,job,token,result,d,p});
 }finally{db.close();rmSync(dir,{recursive:true})}
}
test('scheduled and paused jobs cannot be claimed; pause preserves running results; resume cannot resurrect cancellation',()=>fixture(async({db,call,base,job,token,result})=>{
 assert.equal((await job({not_before:'not-a-date'})).httpStatus,422);
 const scheduled=await job({not_before:new Date(Date.now()+3600000).toISOString()});
 assert.equal((await call('/runner/claim',{},token)).attempt,null);
 await call(base+'/jobs/'+scheduled.id+'/pause',{});
 await db.prepare("UPDATE evo_objects SET payload=json_set(payload,'$.not_before','2020-01-01T00:00:00.000Z') WHERE id=?").bind(scheduled.id).run();
 assert.equal((await call('/runner/claim',{},token)).attempt,null);
 await call(base+'/jobs/'+scheduled.id+'/resume',{});
 const a=(await call('/runner/claim',{},token)).attempt;assert.ok(a);
 await call(base+'/jobs/'+scheduled.id+'/pause',{});
 assert.equal((await call('/runner/result',{attempt_id:a.attempt_id,lease:a.lease,result},token)).accepted,true);
 const cancelled=await job();await call(base+'/jobs/'+cancelled.id+'/cancel',{});await call(base+'/jobs/'+cancelled.id+'/resume',{});
 assert.equal((await call('/runner/claim',{},token)).attempt,null);
}));
test('conditional paths are validated for connector and offline uploads and different paths are incomparable',()=>fixture(async({call,base,job,token,result,p})=>{
 const j=await job(),a=(await call('/runner/claim',{},token)).attempt;
 assert.deepEqual(a.input.turns[1].branch,{contains:'Thursday',message:'Confirm Thursday'});
 assert.ok(!JSON.stringify(a).includes('Retain Thursday'));
 const wrong={...result,turns:[result.turns[0],{question:'Default followup',answer:'wrong path'}]};
 assert.equal((await call('/runner/result',{attempt_id:a.attempt_id,lease:a.lease,result:wrong},token)).httpStatus,422);
 assert.equal((await call('/runner/result',{attempt_id:a.attempt_id,lease:a.lease,result},token)).accepted,true);
 const snap=await call(base+'/jobs/'+j.id+'/snapshot');assert.deepEqual(snap.units[0].source.dialogue_path,['When?','Confirm Thursday']);
 const other={...snap,units:snap.units.map(u=>({...u,source:{...u.source,dialogue_path:['When?','Default followup']}}))};assert.match(compareJobs(other,snap).rows[0].reason,/追问路径/);
 const off=await job(),bundle=await call(base+'/jobs/'+off.id+'/bundle'),item=bundle.attempts[0];
 const packet={schema:'evo-offline-results-v1',project_id:p.id,job_id:off.id,dataset_version:off.dataset_version,results:[{attempt_id:item.attempt_id,case_id:item.case_id,repeat:item.repeat,result:wrong}]};
 assert.equal((await call(base+'/jobs/'+off.id+'/offline',packet)).httpStatus,422);
 packet.results[0].result=result;assert.equal((await call(base+'/jobs/'+off.id+'/offline',packet)).accepted,1);
}));
test('review calibration ignores automated checks; candidates require reviewed gold; decisions freeze evidence and reject stale scores',()=>fixture(async({db,call,base,job,token,result,p})=>{
 const j=await job({purpose:'regression'}),a=(await call('/runner/claim',{},token)).attempt;
 await call('/runner/result',{attempt_id:a.attempt_id,lease:a.lease,result},token);
 const assessment={job_id:j.id,attempt_id:a.attempt_id,status:'completed',result:{model:'fixture',quality:'fail',turns:[1,2].map(turn=>({turn,dimensions:['factual','coverage','relevance','context'].map(dimension=>({dimension,score:2}))})),critical_findings:[{reason:'Fixture risk'}]}};
 await db.prepare('INSERT INTO evo_objects VALUES(?,?,?,?,?)').bind('fixture-assessment',p.id,'assessment',new Date().toISOString(),JSON.stringify(assessment)).run();
 const snap=await call(base+'/jobs/'+j.id+'/snapshot');
 const review={record_id:a.attempt_id,snapshot_id:snap.snapshot_id,status:'disputed',reason:'Fixture reason',effort:'small'};
 await call(base+'/jobs/'+j.id+'/reviews',{...review,reviewer_type:'automated_engineering_acceptance'});
 let q=await call(base+'/calibration');assert.equal(q.summary.reviewed,0);assert.equal(q.summary.pending,1);
 await call(base+'/jobs/'+j.id+'/reviews',review);q=await call(base+'/calibration');assert.equal(q.summary.disputed,1);assert.equal(q.summary.reviewed,1);assert.equal(q.items[0].quality,'fail');
 assert.equal((await call(base+'/calibration',undefined,undefined,'bob')).httpStatus,404);
 assert.equal((await call(base+'/candidates/capture',{})).captured,1);assert.equal((await call(base+'/candidates/capture',{})).captured,0);
 const candidate=(await call(base+'/candidates')).items[0];
 assert.equal((await call(base+'/candidates/'+candidate.id+'/promote',{confirmed:false,expectation:'Confirm correct date'})).httpStatus,422);
 const promoted=await call(base+'/candidates/'+candidate.id+'/promote',{confirmed:true,expectation:'Confirm correct date',reference:'Thursday'});
 assert.equal(promoted.cases[0].review_status,'confirmed');assert.equal(promoted.cases[0].expected.behavior,'Confirm correct date');assert.equal(promoted.generation.source_record,a.attempt_id);
 const decision={snapshot_id:snap.snapshot_id,outcome:'fix',reason:'Fix date retention before retesting',records:[a.attempt_id]};
 assert.equal((await call(base+'/jobs/'+j.id+'/decisions',{...decision,outcome:'continue'})).httpStatus,422);
 assert.equal((await call(base+'/jobs/'+j.id+'/decisions',{...decision,records:['foreign-record']})).httpStatus,422);
 assert.equal((await call(base+'/jobs/'+j.id+'/decisions',decision)).httpStatus,201);
 const saved=(await call(base+'/jobs/'+j.id+'/decisions')).items[0];assert.equal(saved.snapshot.snapshot_id,snap.snapshot_id);assert.equal(saved.actor,'alice');
 assessment.result.quality='pass';assessment.result.critical_findings=[];assessment.result.turns.forEach(t=>t.dimensions.forEach(d=>d.score=5));
 await db.prepare('UPDATE evo_objects SET payload=? WHERE id=?').bind(JSON.stringify(assessment),'fixture-assessment').run();
 assert.equal((await call(base+'/jobs/'+j.id+'/decisions',decision)).httpStatus,409);
 assert.equal((await call(base+'/candidates/'+candidate.id+'/promote',{confirmed:true,expectation:'Stale expected fact'})).httpStatus,409);
 q=await call(base+'/calibration');assert.equal(q.summary.reviewed,0);assert.equal(q.summary.pending,1);
 const latest=await call(base+'/jobs/'+j.id+'/snapshot');assert.equal((await call(base+'/jobs/'+j.id+'/decisions',{...decision,snapshot_id:latest.snapshot_id,outcome:'continue'})).httpStatus,201);
 assert.equal((await call(base+'/jobs/'+j.id+'/decisions')).items.find(d=>d.id===saved.id).snapshot.units[0].quality,'fail');
}));
test('issue merges and splits retain evidence and revision history without losing records',()=>fixture(async({call,base,job,token,result})=>{
 const ids=[];for(let i=0;i<3;i++){await job();const a=(await call('/runner/claim',{},token)).attempt;await call('/runner/result',{attempt_id:a.attempt_id,lease:a.lease,result},token);ids.push(a.attempt_id)}
 const first=await call(base+'/issues',{title:'Same observed behavior',reason:'Fixture grouping reason',records:ids.slice(0,2)});assert.equal(first.httpStatus,201);
 assert.equal((await call(base+'/issues',{title:'Unknown evidence',reason:'Cannot invent records',records:['absent']})).httpStatus,422);
 assert.equal((await call(base+'/issues',{title:'Partial grouping',reason:'Cannot silently remove member',records:[ids[0],ids[2]]})).httpStatus,422);
 const group=(await call(base+'/issues')).items[0];assert.equal(group.records.length,2);
 const split=await call(base+'/issues/'+group.group_id+'/split',{revision:group.id,records:[ids[0]],reason:'Different observable behavior'});assert.equal(split.httpStatus,201);
 assert.equal((await call(base+'/issues/'+group.group_id+'/split',{revision:group.id,records:[ids[0]],reason:'Old group revision'})).httpStatus,409);
 let groups=await call(base+'/issues');assert.equal(groups.items.length,2);assert.equal(groups.history.length,3);
 const merged=await call(base+'/issues',{title:'Combined after review',reason:'Both share the same observed behavior',records:ids});assert.equal(merged.httpStatus,201);
 groups=await call(base+'/issues');assert.equal(groups.items.length,1);assert.deepEqual(groups.items[0].records.map(r=>r.record_id).sort(),ids.sort());assert.equal(groups.history.length,6);
 assert.equal((await call(base+'/issues',undefined,undefined,'bob')).httpStatus,404);
}));
