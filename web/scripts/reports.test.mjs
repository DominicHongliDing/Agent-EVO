import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {IDBFactory} from 'fake-indexeddb';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import {reportAnswerUnit,reportMetrics,reportMaterial,validateReport,compareReportSnapshots} from '../src/reportCore.mjs';
// Use React's Node renderer in Node tests. The browser renderer keeps a
// MessageChannel alive after assertions finish, preventing the test runner exiting.
const {outputFiles}=await build({stdin:{contents:"export * from './src/reportClient';export * from './src/browserAnswers';export * from './src/reportDocument';",resolveDir:process.cwd()},alias:{'decode-named-character-reference':path.resolve('node_modules/decode-named-character-reference/index.js')},platform:'node',banner:{js:`import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(import.meta.url)});`},bundle:true,write:false,format:'esm',target:'es2022'});
const post=data=>({method:'POST',body:JSON.stringify(data)});
function locks(){const pending=new Map(),held=new Set();return {query:async()=>({held:[...held].map(name=>({name}))}),request:async(name,options,fn)=>{if(typeof options==='function'){fn=options;options={}}if(options.ifAvailable&&held.has(name))return fn(null);let release;const done=new Promise(r=>release=r),previous=pending.get(name)||Promise.resolve();pending.set(name,previous.then(()=>done));await previous;held.add(name);try{return await fn({name})}finally{held.delete(name);release()}}}}
function content(){const row={text:'记录已保存，仍需人工复核。',metric_refs:['planned'],evidence:[]};return {summary:[row],strengths:[],issues:[],recommendations:[],limitations:[structuredClone(row)]}}
test('baseline comparison excludes incomplete grades and incompatible standards',()=>{
 const unit={id:'one',question_key:'same-input',profile:'native-single',rubric:'rubric-v1',dimensions:{clarity:4,coverage:5,evidence_consistency:3},quality:'pass',execution:'completed',critical:[],low_turns:[],turn_count:1,assessment_status:'completed'};
 const a={snapshot_id:'a',units:[unit]},b={snapshot_id:'b',units:[{...unit,dimensions:{clarity:2,coverage:3,evidence_consistency:1}}]};
 assert.equal(compareReportSnapshots(a,b).delta,40);b.units[0].rubric='different';assert.equal(compareReportSnapshots(a,b).compared_questions,0);assert.equal(compareReportSnapshots(a,b).delta,null);
 assert.equal(reportMetrics([unit],3).stability,null);
});
test('browser reports reuse ephemeral key, deduplicate, preserve stale snapshot and escape exports',async()=>{
 globalThis.indexedDB=new IDBFactory();Object.defineProperty(globalThis.navigator,'locks',{value:locks(),configurable:true});globalThis.document={documentElement:{dataset:{evoMode:'clinical-public'}}};globalThis.location={origin:'https://example.test',search:'?space=mine'};
 const w=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
 await w.browserAnswerRequest('/judge',post({api_key:'fixture-key-not-real',model:'qwen3.6-flash'}));
 assert.equal((await w.reportConfig()).configured,true);assert.equal((await w.reportConfig()).model,'qwen3.8-max-0902');
 const form=new FormData();form.set('file',new File([JSON.stringify([{question:'怎么整理信息？',answer:'按持续时间整理。',reference:'记录持续时间'}])],'fixture.json'));
 const f=await w.browserAnswerRequest('/imports',{method:'POST',body:form});const b=await w.browserAnswerRequest('/imports/'+f.import_id+'/commit',post({mapping:f.mapping,reviewed_deidentified:true,name:'<script>alert(1)</script>'}));
 let calls=0;globalThis.fetch=async(url,opts)=>{calls++;assert.equal(url,'/api/evaluation/report');assert.equal(opts.headers.Authorization,'Bearer fixture-key-not-real');assert.ok(!opts.body.includes('fixture-key-not-real'));await new Promise(r=>setTimeout(r,15));return Response.json({status:'completed',report:content(),model:'qwen3.8-max-0902',business_calls:0,ai_coverage:{selected:1,total:1},usage:[{request_id:'fixture-only',usage:{total_tokens:42}}]})};
 const one=await w.createReport('answers',b.batch_id),two=await w.createReport('answers',b.batch_id);assert.equal(one.report_id,two.report_id);
 let data;for(let i=0;i<100;i++){data=await w.loadReports('answers',b.batch_id);if(data.reports[0].status==='completed')break;await new Promise(r=>setTimeout(r,10))}
 assert.equal(calls,1);assert.equal(data.reports[0].status,'completed');assert.equal(data.snapshot.metrics.score,null);assert.ok(!JSON.stringify(data).includes('fixture-key-not-real'));
 const markdown=w.reportMarkdown(data.snapshot,data.reports[0]);assert.equal((markdown.match(/^## /gm)||[]).length,8);const html=w.reportHtml(markdown);assert.ok(!html.includes('<script>'));assert.ok(html.includes("default-src 'none'"));
 const record=(await w.browserAnswerRequest('/batches/'+b.batch_id)).records[0];globalThis.fetch=async()=>Response.json({status:'failed',result:{reason:'fixture failure'}});
 await w.browserAnswerRequest('/batches/'+b.batch_id+'/judge',post({}));for(let i=0;i<100;i++){const r=await w.browserAnswerRequest('/records/'+record.record_id);if(!['queued','running'].includes(r.assessments[0].status))break;await new Promise(r=>setTimeout(r,10))}
 const after=await w.loadReports('answers',b.batch_id);assert.equal(after.reports[0].stale,true);assert.equal((await w.reportSnapshot(one.report_id)).snapshot_id,data.snapshot.snapshot_id);
});
test('Site report handler stops on quota and limits repairs, without executing Agent tools',async()=>{
 const policy=JSON.parse(await readFile('../src/agent_evo/report_policy.json','utf8')),core=await readFile('src/reportCore.mjs','utf8'),handler=await readFile('../integrations/sites/report.js','utf8');
 let calls=0,mode='ok';const context={Response,Request,Uint8Array,TextDecoder,AbortSignal,JSON,reportPolicy:policy,fetch:async(url,init)=>{calls++;assert.equal(url,'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');assert.equal(init.redirect,'manual');if(mode==='quota')return Response.json({error:{code:'AllocationQuota.FreeTierOnly'}},{status:403});return Response.json({id:'fixture-only',usage:{total_tokens:25},choices:[{message:{content:JSON.stringify(mode==='ok'?content():{})}}]})}};
 vm.createContext(context);vm.runInContext(core.replaceAll('export ','')+'\n'+handler+'\nthis.run=generateEvaluationReport;',context);
 const material=reportMaterial({version:policy.version,metrics:reportMetrics([]),units:[]});const request=()=>new Request('https://example.test/api/evaluation/report',{method:'POST',headers:{'X-EVO-Reports':'1',Authorization:'Bearer fixture-only-key'},body:JSON.stringify({material,model:policy.model})});
 assert.equal((await(await context.run(request())).json()).status,'completed');assert.equal(calls,1);
 mode='quota';calls=0;const fail=await(await context.run(request())).json();assert.equal(fail.error_code,'AllocationQuota.FreeTierOnly');assert.equal(calls,1);
 mode='invalid';calls=0;assert.equal((await(await context.run(request())).json()).status,'failed');assert.equal(calls,2);
});
