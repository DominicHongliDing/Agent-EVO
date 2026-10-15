import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkDraftQuality} from './draft-check.mjs';
import {generateCases} from './generation.mjs';
import {draftCheckSignature} from '../../web/src/draftCheckContract.mjs';
import {coverageGaps,defaultCoverage} from '../../web/src/coveragePlan.mjs';
import {generateBatch} from '../../web/src/generateBatch.mjs';
import {workbench} from './core.mjs';
import {localDatabase} from './local-server.mjs';
const product={description:'帮助客户查询订单进度，不支持直接退款。'};
const c={case_id:'case1',category:'core',turns:[{message:'订单什么时候送到？'}],expected:{behavior:'查询订单进度'},review_status:'draft'};
const key='fixture-not-a-real-key';
const response=checks=>async()=>Response.json({id:'fixture',choices:[{message:{content:JSON.stringify({checks})}}]});
const clear={status:'clear',reason:'与查询订单职责一致',evidence:[]};
test('independent check requires genuine citations, missing and duplicate output stay unknown',async()=>{
 const result=await checkDraftQuality({...product,cases:[c]},key,response([{case_id:c.case_id,scope:clear,consistency:{status:'flagged',reason:'核对预期',evidence:[{ref:'expected',quote:'查询订单进度'}]}}]));
 assert.equal(result.checks[0].consistency.status,'flagged');assert.equal(result.checks[0].signature,draftCheckSignature(product,c));assert.equal(result.business_calls,0);assert.ok(!JSON.stringify(result).includes(key));
 const bad=await checkDraftQuality({...product,cases:[c]},key,response([{case_id:c.case_id,scope:clear,consistency:{status:'flagged',reason:'假引用',evidence:[{ref:'expected',quote:'自动退款'}]}}]));assert.equal(bad.checks[0].consistency.status,'unknown');
 const duplicate=await checkDraftQuality({...product,cases:[c]},key,response([{case_id:c.case_id,scope:clear},{case_id:c.case_id,scope:clear}]));assert.equal(duplicate.checks[0].scope.status,'unknown');
 assert.equal(draftCheckSignature(product,c),draftCheckSignature(product,{...c,review_status:'confirmed'}));
 assert.notEqual(draftCheckSignature(product,c),draftCheckSignature({...product,boundaries:'只能查询'},c));
 assert.notEqual(draftCheckSignature(product,c),draftCheckSignature(product,{...c,expected:{behavior:'自动退款'}}));
 let calls=0;await assert.rejects(()=>checkDraftQuality({...product,cases:[c]},key,async()=>{calls++;return Response.json({error:{code:'AllocationQuota.FreeTierOnly'}},{status:403})}),/额度/);assert.equal(calls,1);
});
test('quota enforced before requests and generated category or context violations discarded',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify({cases:[{category:'context',turns:[{message:'第一轮'}],expectation:'保留上下文'},{category:'core',turns:[{message:'订单进度'}],expectation:'查进度'},{category:'refusal',turns:[{message:'请直接退款'}],expectation:'解释不支持退款'}]})}}]})};
 await assert.rejects(()=>generateCases({...product,count:3,coverage:defaultCoverage(5)},key,fetcher),/配额/);assert.equal(calls,0);
 const result=await generateCases({...product,count:3,coverage:{core:0,boundary:0,context:2,refusal:1,focus:0}},key,fetcher);assert.equal(result.cases.length,1);assert.equal(result.cases[0].category,'refusal');assert.equal(result.generation.issues.length,2);
});
test('targeted replenishment ignores surplus, preserves old rows and fills exact missing categories',async()=>{
 const plan=defaultCoverage(50),initial=Array.from({length:25},(_,i)=>({...c,case_id:'old'+i}));let sequence=0;
 const out=await generateBatch({initial,count:30,plan,request:async input=>({cases:Object.entries(input.coverage).flatMap(([category,n])=>Array.from({length:n},()=>({...c,case_id:'new'+sequence++,category,turns:category==='context'?[{message:'先问'},{message:'再问'}]:c.turns})))}),onBatch:()=>{}});
 assert.equal(out.rows.length,55);assert.equal(coverageGaps(plan,out.rows).missing,0);assert.equal(out.rows[0],initial[0]);
 let calls=0;await assert.rejects(()=>generateBatch({initial:Array.from({length:90},()=>c),count:10,plan,request:async()=>{calls++},onBatch:()=>{}}),/超过 100/);assert.equal(calls,0);
});
test('checks are project-owned; frozen dataset retains purpose and plan',async()=>{
 const db=localDatabase(':memory:'); // adapter resolves only directory; in-memory SQLite leaves no fixture data
 const call=async(path,data,owner='alice')=>{const r=await workbench(new Request('https://evo.test/api/workbench'+path,{method:data?'POST':'GET',headers:{'X-EVO-Workbench':'1','oai-authenticated-user-id':owner},body:data?JSON.stringify(data):undefined}),{DB:db});return {status:r.status,...await r.json()}};
 try{const p=await call('/projects',{name:'质量检查'}),base='/projects/'+p.id;
 assert.equal((await call(base+'/draft-checks',undefined,'bob')).status,404);
 assert.equal((await call(base+'/draft-checks',{...product,cases:[c]},'bob')).status,404);
 const d=await call(base+'/datasets',{name:'样本',cases:[c],preparation:{product,plan:defaultCoverage(5)}});assert.equal(d.status,201);assert.equal(d.preparation.product.description,product.description);assert.deepEqual(d.preparation.plan,defaultCoverage(5));
 assert.equal((await call(base+'/datasets',{name:'坏配额',cases:[c],preparation:{product,plan:{core:-1}}})).status,422);
 }finally{db.close()}
});
