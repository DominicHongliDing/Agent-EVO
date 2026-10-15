import {checkDraftQuality} from './draft-check.mjs';
import {draftCheckProduct} from '../../web/src/draftCheckContract.mjs';
import {validatePlan} from '../../web/src/coveragePlan.mjs';
import {workbenchTurnMessage,workbenchDialogueMatches} from './dialogue.mjs';
// Shared Worker / local Node service. SQL adapters expose D1's prepare/batch interface.
import {workbenchImprovement} from './improvement.mjs';
import {generateCases} from './generation.mjs';
import {judgeWorkbench} from './judge.mjs';
import {attemptRecord,jobSnapshot,compareJobs} from './analysis.mjs';
import {generateEvaluationReport} from './reports.mjs';
import {reportMaterial} from '../../web/src/reportCore.mjs';
import {prepareTraceSync,sendTraceSync} from './trace-sync.mjs';
const stamp=()=>new Date().toISOString();
const ident=(prefix)=>prefix+'_'+crypto.randomUUID().replaceAll('-','');
const json=(v,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
class Fault extends Error{constructor(status,message){super(message);this.status=status}}
const need=(ok,message,status=422)=>{if(!ok)throw new Fault(status,message)};
const hash=async(value)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
const str=(value,max=2000)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
function clean(value){if(Array.isArray(value))return value.map(clean);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/password|secret|api.?key|authorization|access.?token/i.test(k)).map(([k,v])=>[k,clean(v)]));return typeof value==='string'?value.replace(/\bsk-[\w-]{10,}|Bearer\s+[\w.-]+/gi,'[凭证已移除]'):value}
async function body(request){let size=0;const parts=[],reader=request.body?.getReader();if(reader)while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024){await reader.cancel();throw new Fault(413,'材料超过 2 MiB')}parts.push(value)}const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length}try{return JSON.parse(new TextDecoder().decode(bytes))}catch{throw new Fault(422,'请提供有效 JSON 材料')}}
async function all(db,sql,...args){return (await db.prepare(sql).bind(...args).all()).results}
async function one(db,sql,...args){return db.prepare(sql).bind(...args).first()}
async function object(db,id,project,kind){const row=await one(db,'SELECT * FROM evo_objects WHERE id=? AND project=? AND kind=?',id,project,kind);need(row,'项目中的材料不存在',404);return {...JSON.parse(row.payload),id:row.id,created_at:row.created}}
async function save(db,project,kind,payload,id=ident(kind)){await db.prepare('INSERT INTO evo_objects VALUES(?,?,?,?,?)').bind(id,project,kind,stamp(),JSON.stringify(clean(payload))).run();return {...payload,id}}
const viewAttempt=row=>({...row,input:JSON.parse(row.input),result:row.result?JSON.parse(row.result):null,lease:undefined});
export function validateCases(cases){
 need(Array.isArray(cases)&&cases.length>0&&cases.length<=100,'请准备 1–100 道问题');const seen=new Set();
 return cases.map((c,i)=>{const id=String(c.case_id||`case_${i+1}`);need(/^[\w.-]{1,100}$/.test(id)&&!seen.has(id),'用例 ID 重复或格式无效');seen.add(id);
 const turns=(c.turns?.length?c.turns:[{message:c.message}]);need(Array.isArray(turns)&&turns.length<=20&&turns.every(t=>str(t.message,12000)),'每题需要 1–20 轮非空问题');
 need(['draft','confirmed','needs_reference','disabled'].includes(c.review_status||'draft'),'审核状态无效');
 return {case_id:id,title:String(c.title||turns[0].message).slice(0,200),turns:turns.map((t,j)=>{if(t.branch)need(j>0&&str(t.branch.contains,200)&&str(t.branch.message,12000),'条件追问只能用于第二轮起，关键词和追问不能为空');return {message:t.message,...(t.branch?{branch:{contains:t.branch.contains,message:t.branch.message}}:{})}}),expected:clean(c.expected||{}),reference:String(c.reference||'').slice(0,20000),category:String(c.category||'general').slice(0,80),review_status:c.review_status||'draft',split:c.split==='holdout'?'holdout':'tuning',synthetic:c.synthetic===true};});
}
function inputOnly(c){return {case_id:c.case_id,turns:c.turns.map(t=>({message:t.message,...(t.branch?{branch:t.branch}:{})}))}}
export async function workbench(request,env){
 try{
 const db=env.DB;need(db,'持久任务服务尚未配置，请使用离线执行包',503);
 const url=new URL(request.url),path=url.pathname.replace(/^\/api\/workbench/,'');
 const method=request.method;
 if(method!=='GET'){need(request.headers.get('X-EVO-Workbench')==='1','请从工作台或连接器提交',403);const origin=request.headers.get('Origin');need(!origin||origin===url.origin,'来源不匹配',403)}
 const workspace=request.headers.get('X-EVO-Workspace')||'';
 const account=env.LOCAL_OWNER||request.headers.get('oai-authenticated-user-id');
 const guest=!account&&/^[a-f0-9]{64}$/.test(workspace);
 const owner=account||(guest?'guest:'+await hash(workspace):null);
 if(path==='/session'&&method==='GET')return json({authenticated:!!owner,guest,storage:'server',local:!!env.LOCAL_OWNER});
 // Connector identity is scoped to exactly one project and connection; it cannot read expected answers.
 if(path.startsWith('/runner/')){
 const token=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');need(token.length>=32,'连接器授权无效',401);
 const grant=await one(db,'SELECT * FROM evo_tokens WHERE digest=? AND revoked=0',await hash(token));need(grant,'连接器授权已失效',401);
 await db.prepare("UPDATE evo_attempts SET status='uncertain', lease=NULL WHERE project=? AND connection=? AND status='running' AND lease_until<?").bind(grant.project,grant.connection,Date.now()).run();
 const data=await body(request);
 if(path==='/runner/claim'&&method==='POST'){
 const lease=ident('lease');
 const row=await one(db,"UPDATE evo_attempts SET status='running',lease=?,lease_until=? WHERE id=(SELECT id FROM evo_attempts WHERE project=? AND connection=? AND status='queued' AND job IN (SELECT id FROM evo_objects WHERE kind='job' AND COALESCE(json_extract(payload,'$.paused'),0)=0 AND (json_extract(payload,'$.not_before') IS NULL OR json_extract(payload,'$.not_before')<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))) ORDER BY created,id LIMIT 1) AND status='queued' RETURNING *",lease,Date.now()+120000,grant.project,grant.connection);
 if(!row)return json({attempt:null});
 const connection=await object(db,grant.connection,grant.project,'connection');
 return json({attempt:{attempt_id:row.id,job_id:row.job,case_id:row.case_id,repeat:row.repeat_no,lease,input:JSON.parse(row.input),agent_version:(await object(db,row.job,grant.project,'job')).agent_version,connection,lease_seconds:120}});
 }
 const row=await one(db,'SELECT * FROM evo_attempts WHERE id=? AND project=? AND connection=?',data.attempt_id,grant.project,grant.connection);need(row,'执行记录不存在',404);
 if(path==='/runner/heartbeat'&&method==='POST'){need(row.status==='running'&&row.lease===data.lease,'租约已失效，禁止重新执行',409);await db.prepare('UPDATE evo_attempts SET lease_until=? WHERE id=? AND lease=? AND status=\'running\'').bind(Date.now()+120000,row.id,data.lease).run();return json({ok:true})}
 if(path==='/runner/result'&&method==='POST'){
 const result=clean(data.result);need(result&&['completed','failed','uncertain'].includes(result.status),'结果状态无效');result.source='connector_submitted';
 const expected=JSON.parse(row.input);
 if(result.status==='completed')need(Array.isArray(result.turns)&&workbenchDialogueMatches(expected,result.turns)&&result.turns.every(t=>str(t.answer,100000)),'回答必须对应原题及全部轮次');
 need(str(result.agent_version,200)&&str(result.conversation_id,200),'请保留版本和会话标识');
 const digest=await hash(JSON.stringify(result));if(row.result_hash){need(row.result_hash===digest,'重复上传内容不同，原证据已保留',409);return json({accepted:true,reused:true})}
 need(row.status==='running'&&row.lease===data.lease,'任务取消或租约已失效；请保留本地结果供人工导入',409);
 const updated=await one(db,'UPDATE evo_attempts SET status=?,result=?,result_hash=?,lease=NULL WHERE id=? AND status=\'running\' AND lease=? RETURNING id',result.status,JSON.stringify(result),digest,row.id,data.lease);need(updated,'提交冲突，原结果保留',409);return json({accepted:true,reused:false});
 }
 throw new Fault(404,'连接器操作不存在');
 }
 need(owner,'工作区尚未就绪，请回到评测页面重试',401);
 if(path==='/projects'){
 if(method==='GET')return json({items:await all(db,'SELECT id,name,created FROM evo_projects WHERE owner=? ORDER BY created DESC',owner)});
 if(method==='POST'){const data=await body(request);need(str(data.name,120),'请给项目起个名字');const id=ident('project');await db.prepare('INSERT INTO evo_projects VALUES(?,?,?,?)').bind(id,owner,data.name,stamp()).run();return json({id,name:data.name},201)}
 }
 const m=path.match(/^\/projects\/([\w-]+)(.*)$/);need(m,'接口不存在',404);const project=m[1],rest=m[2];
 need(await one(db,'SELECT id FROM evo_projects WHERE id=? AND owner=?',project,owner),'项目不存在或无权访问',404);
 const extra=await workbenchImprovement({db,project,rest,method,request,owner,all,one,object,save,body,need,hash,stamp,ident,json,validateCases,viewAttempt,jobSnapshot});if(extra)return extra;
 if(rest==='/generate'&&method==='POST'){const data=await body(request),key=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');let result;try{result=await generateCases(data,key)}catch(e){throw new Fault(422,e.message)}return json(await save(db,project,'draft',result),201)}
 if(rest==='/draft-checks'&&method==='POST'){const data=clean(await body(request));data.cases=validateCases(data.cases);let result;try{result=await checkDraftQuality(data,(request.headers.get('Authorization')||'').replace(/^Bearer /,''))}catch(e){throw new Fault(422,e.message)}return json(await save(db,project,'draftcheck',result),201)}
 if(rest==='/draft-checks'&&method==='GET')return json({items:(await all(db,"SELECT * FROM evo_objects WHERE project=? AND kind='draftcheck' ORDER BY created DESC LIMIT 100",project)).map(r=>({...JSON.parse(r.payload),id:r.id}))});
 if(rest==='/drafts'&&method==='GET')return json({items:(await all(db,"SELECT * FROM evo_objects WHERE project=? AND kind='draft' ORDER BY created DESC",project)).map(r=>({...JSON.parse(r.payload),id:r.id}))});
 if(rest==='/connections'){
 if(method==='GET')return json({items:(await all(db,"SELECT * FROM evo_objects WHERE project=? AND kind='connection' ORDER BY created DESC",project)).map(r=>({...JSON.parse(r.payload),id:r.id}))});
 if(method==='POST'){const data=await body(request);need(str(data.name,120)&&['http','pull','python','langgraph','dify','langchain'].includes(data.kind),'请填写连接名称和方式');
 if(data.kind==='http'){let target;try{target=new URL(data.url)}catch{}need(target&&['http:','https:'].includes(target.protocol)&&!target.username&&!target.password,'请输入业务 HTTP 地址');}
 return json(await save(db,project,'connection',{name:data.name,kind:data.kind,url:data.kind==='http'?data.url:'',answer_path:data.answer_path||'answer',session_path:data.session_path||'conversation_id',description:String(data.description||'').slice(0,2000)}),201)}
 }
 if(rest==='/datasets'){
 if(method==='GET')return json({items:(await all(db,"SELECT * FROM evo_objects WHERE project=? AND kind='dataset' ORDER BY created DESC",project)).map(r=>({...JSON.parse(r.payload),id:r.id}))});
 if(method==='POST'){const data=await body(request),cases=validateCases(data.cases);need(str(data.name,120),'请填写测试集名称');let preparation=null;if(data.preparation){const product=draftCheckProduct(data.preparation.product||{});need(product.description.length<=6000&&product.success.length<=6000&&product.boundaries.length<=4000&&product.references.length<=18000,'产品说明过长');try{validatePlan(data.preparation.plan)}catch(e){throw new Fault(422,e.message)}preparation={product,plan:data.preparation.plan}}return json(await save(db,project,'dataset',{preparation,name:data.name,version:ident('version'),cases,sha256:await hash(JSON.stringify(cases)),generation:data.generation||null}),201)}
 }
 if(rest==='/tokens'&&method==='POST'){const data=await body(request);await object(db,data.connection,project,'connection');const token=ident('evo')+ident('key'),id=ident('token');await db.prepare('INSERT INTO evo_tokens VALUES(?,?,?,?,?,0)').bind(id,project,data.connection,await hash(token),stamp()).run();return json({id,token,connection:data.connection,notice:'仅本次显示；只可领取此项目此连接的任务，可撤销。'},201)}
 if(rest==='/tokens'&&method==='GET')return json({items:await all(db,'SELECT id,connection,created,revoked FROM evo_tokens WHERE project=? ORDER BY created DESC',project)});
 if(/^\/tokens\/[\w-]+$/.test(rest)&&method==='DELETE'){await db.prepare('UPDATE evo_tokens SET revoked=1 WHERE id=? AND project=?').bind(rest.split('/')[2],project).run();return json({ok:true})}
 if(rest==='/jobs'){
 if(method==='GET')return json({items:(await all(db,"SELECT * FROM evo_objects WHERE project=? AND kind='job' ORDER BY created DESC",project)).map(r=>({...JSON.parse(r.payload),id:r.id,created_at:r.created}))});
 if(method==='POST'){
 const data=await body(request),dataset=await object(db,data.dataset,project,'dataset'),connection=await object(db,data.connection,project,'connection');need(str(data.agent_version,200),'请填写本次 Agent 版本');
 if(data.parent_job){const parent=await object(db,data.parent_job,project,'job');need(parent.connection===connection.id&&parent.dataset_version===dataset.version,'回归需要沿用原连接和冻结题库')}
 const repeats=data.repeats||1;need(Number.isInteger(repeats)&&repeats>=1&&repeats<=5,'重复次数为 1–5');
 const cases=dataset.cases.filter(c=>c.review_status!=='disabled'&&(!data.case_ids?.length||data.case_ids.includes(c.case_id)));need(cases.length>0,'请选择至少一题');need(data.exploratory===true||cases.every(c=>c.review_status==='confirmed'),'预期尚未确认，请先审核或选择探索运行');
 need(!data.not_before||Number.isFinite(Date.parse(data.not_before)),'预约时间格式无效');const notBefore=data.not_before?new Date(data.not_before).toISOString():null;need(!notBefore||(Date.parse(notBefore)>Date.now()&&Date.parse(notBefore)<Date.now()+31*86400000),'预约时间须在未来 31 天内');
 const job=ident('job'),payload={name:String(data.name||dataset.name).slice(0,150),purpose:['quality','compare','regression'].includes(data.purpose)?data.purpose:'quality',paused:false,not_before:notBefore,dataset:data.dataset,dataset_version:dataset.version,connection:connection.id,agent_version:data.agent_version,repeats,exploratory:!!data.exploratory,planned:cases.length*repeats,parent_job:data.parent_job||null,case_ids:cases.map(c=>c.case_id)};
 const statements=[db.prepare('INSERT INTO evo_objects VALUES(?,?,?,?,?)').bind(job,project,'job',stamp(),JSON.stringify(payload))];
 for(const c of cases)for(let n=1;n<=repeats;n++)statements.push(db.prepare("INSERT INTO evo_attempts(id,project,job,connection,case_id,repeat_no,status,input,created) VALUES(?,?,?,?,?,?,'queued',?,?)").bind(ident('attempt'),project,job,connection.id,c.case_id,n,JSON.stringify(inputOnly(c)),stamp()));
 await db.batch(statements);return json({...payload,id:job},201);
 }
 }
 const jm=rest.match(/^\/jobs\/([\w-]+)(.*)$/);
 if(jm){const job=await object(db,jm[1],project,'job'),suffix=jm[2];
 const assessments=async()=>(await all(db,"SELECT * FROM evo_objects WHERE project=? AND kind='assessment' ORDER BY created DESC",project)).map(r=>({...JSON.parse(r.payload),assessment_id:r.id,created_at:r.created})).filter(r=>r.job_id===job.id);
 const rows=async()=>(await all(db,'SELECT * FROM evo_attempts WHERE job=? AND project=? ORDER BY case_id,repeat_no',job.id,project)).map(viewAttempt);
 const snapshot=async()=>jobSnapshot(job,await object(db,job.dataset,project,'dataset'),await rows(),await assessments());
 if(suffix==='/sync'&&method==='GET')return json({items:(await all(db,"SELECT * FROM evo_objects WHERE project=? AND kind='trace_sync' ORDER BY created DESC",project)).map(r=>({...JSON.parse(r.payload),id:r.id})).filter(r=>r.job_id===job.id).map(({payload,...r})=>r)});
 if(suffix==='/sync'&&method==='POST'){
 const data=await body(request);need(data.confirm_deidentified===true,'请确认仅同步选定的脱敏记录');const attempts=await rows(),attempt=attempts.find(a=>a.id===data.attempt_id),snap=await snapshot();need(attempt?.result,'请选择已有执行证据的记录');
 const payload=await prepareTraceSync(attempt,snap.units.find(u=>u.id===attempt.id),job),destination=String(data.host||'').replace(/\/$/,'');
 const id='sync_'+(await hash(attempt.id+payload.revision+destination)).slice(0,40),existing=await one(db,'SELECT payload FROM evo_objects WHERE id=? AND project=?',id,project);
 const meta=existing?JSON.parse(existing.payload):{job_id:job.id,attempt_id:attempt.id,revision:payload.revision,destination,payload,status:'pending'};
 if(!existing)await save(db,project,'trace_sync',meta,id);
 if(meta.status==='verified')return json({id,status:meta.status,trace_id:meta.trace_id,notice:'这版证据已回读核验，无需重复发送'});
 let result;try{result=await sendTraceSync(payload,data,!!env.LOCAL_OWNER)}catch(e){result={status:'pending',notice:e.message}}
 await db.prepare('UPDATE evo_objects SET payload=? WHERE id=? AND project=?').bind(JSON.stringify(clean({...meta,...result,updated_at:stamp()})),id,project).run();return json({id,...result});
 }
 if(suffix==='/reports'&&method==='GET')return json({items:(await all(db,"SELECT * FROM evo_objects WHERE project=? AND kind='report' ORDER BY created DESC",project)).map(r=>({...JSON.parse(r.payload),report_id:r.id,created_at:r.created})).filter(r=>r.job_id===job.id)});
 if(suffix==='/reports'&&method==='POST'){
 const data=await body(request),snap=await snapshot();need(!snap.units.some(u=>['queued','running'].includes(u.execution)),'请等待执行结束后生成报告');
 const id=ident('report'),meta={job_id:job.id,snapshot:snap,snapshot_id:snap.snapshot_id,model:data.model||'qwen3.8-max-0902',status:'running'};await save(db,project,'report',meta,id);
 const req=new Request(request.url,{method:'POST',headers:{'X-EVO-Reports':'1',Authorization:request.headers.get('Authorization')||''},body:JSON.stringify({material:reportMaterial(snap),model:meta.model})});
 let result;try{const res=await generateEvaluationReport(req);result=await res.json()}catch{result={status:'failed',error:'报告生成中断，基础报告保留。'}}
 await db.prepare('UPDATE evo_objects SET payload=? WHERE id=? AND project=?').bind(JSON.stringify(clean({...meta,status:result.status||'failed',result})),id,project).run();return json({report_id:id,...meta,status:result.status||'failed',result});
 }
 if(suffix==='/reviews'&&method==='GET')return json({items:(await all(db,"SELECT * FROM evo_objects WHERE project=? AND kind='review' ORDER BY created DESC",project)).map(r=>({...JSON.parse(r.payload),id:r.id,created_at:r.created})).filter(r=>r.job_id===job.id)});
 if(suffix==='/reviews'&&method==='POST'){
 const data=await body(request),snap=await snapshot(),unit=snap.units.find(u=>u.id===data.record_id);
 need(unit,'记录不属于当前任务');need(data.snapshot_id===snap.snapshot_id,'评分已变化，请刷新后审核',409);need(['confirmed','disputed','insufficient','planned','retest','resolved'].includes(data.status)&&str(data.reason,4000),'请选择状态并填写判断依据');
 if(data.status==='resolved'){
 const follow=await object(db,data.retest_job,project,'job');need(follow.id!==job.id&&follow.parent_job===job.id&&follow.connection===job.connection&&follow.dataset_version===job.dataset_version,'必须关联同题库的独立回归任务');
 const r=(await all(db,'SELECT * FROM evo_attempts WHERE job=? AND project=? AND case_id=?',follow.id,project,unit.source.case_id)).map(viewAttempt),js=(await all(db,"SELECT * FROM evo_objects WHERE project=? AND kind='assessment' ORDER BY created DESC",project)).map(x=>({...JSON.parse(x.payload),assessment_id:x.id,created_at:x.created}));
 const rerun=await jobSnapshot(follow,await object(db,follow.dataset,project,'dataset'),r,js.filter(x=>x.job_id===follow.id));need(rerun.units.length>=follow.repeats&&rerun.units.every(u=>u.execution==='completed'&&u.quality==='pass'&&!u.critical.length&&u.repeat_eligible&&u.source.version_matches!==false&&u.review_status==='confirmed'&&Object.values(u.dimensions).every(v=>typeof v==='number')),'重测仍有失败、关键风险或证据缺口，不能标为已验证修复');
 }
 return json(await save(db,project,'review',{...data,job_id:job.id,actor:owner,effort:['unknown','small','medium','large'].includes(data.effort)?data.effort:'unknown',priority:['urgent','planned','experience'].includes(data.priority)?data.priority:'planned'}),201);
 }
 if(suffix==='/snapshot'&&method==='GET')return json(await snapshot());
 if(suffix==='/compare'&&method==='POST'){const data=await body(request),baseline=await object(db,data.baseline,project,'job'),ds=await object(db,baseline.dataset,project,'dataset');const baseRows=(await all(db,'SELECT * FROM evo_attempts WHERE job=? AND project=?',baseline.id,project)).map(viewAttempt),baseJudges=(await all(db,"SELECT * FROM evo_objects WHERE project=? AND kind='assessment' ORDER BY created DESC",project)).map(r=>({...JSON.parse(r.payload),assessment_id:r.id,created_at:r.created})).filter(r=>r.job_id===baseline.id);return json(compareJobs(await snapshot(),await jobSnapshot(baseline,ds,baseRows,baseJudges)))}
 if(suffix==='/judge'&&method==='POST'){
 const data=await body(request),key=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');need(key.length>=10&&key.length<=512,'请提供百炼评审 Key');
 const old=await assessments(),attempts=await rows(),attempt=attempts.find(a=>a.status==='completed'&&(!data.attempt_id||a.id===data.attempt_id)&&(!old.some(j=>j.attempt_id===a.id)||data.rejudge===true));if(!attempt)return json({done:true});
 need(!old.some(j=>j.attempt_id===attempt.id&&j.status==='running'&&Date.now()-Date.parse(j.created_at)<240000),'此记录正在评分，请等待结果',409);
 const id='assessment_'+(await hash(attempt.id+'|'+(old.find(j=>j.attempt_id===attempt.id)?.assessment_id||'initial'))).slice(0,40),meta={job_id:job.id,attempt_id:attempt.id,status:'running',model:data.model||'qwen3.8-max-0902'};try{await save(db,project,'assessment',meta,id)}catch{throw new Fault(409,'此记录已开始评分，请刷新查看')}
 let outcome;try{outcome=await judgeWorkbench(attemptRecord(attempt,await object(db,job.dataset,project,'dataset'),[]),key,meta.model)}catch{outcome={status:'failed',result:{reason:'评审请求中断，未记作通过；请手动重试。'}}}
 await db.prepare('UPDATE evo_objects SET payload=? WHERE id=? AND project=?').bind(JSON.stringify(clean({...meta,...outcome})),id,project).run();
 let candidate_notice; if(outcome.status==='completed')try{await workbenchImprovement({db,project,rest:'/candidates/capture',method:'POST',request,owner,all,one,object,save,body,need,hash,stamp,ident,json,validateCases,viewAttempt,jobSnapshot})}catch{candidate_notice='评分已保存；候选收集暂未完成，可在校准队列手动整理。'}return json({assessment_id:id,attempt_id:attempt.id,...outcome,...(candidate_notice?{candidate_notice}:{})});
 }
 await db.prepare("UPDATE evo_attempts SET status='uncertain',lease=NULL WHERE job=? AND project=? AND status='running' AND lease_until<?").bind(job.id,project,Date.now()).run();
 if(!suffix&&method==='GET')return json({...job,attempts:(await all(db,'SELECT * FROM evo_attempts WHERE job=? AND project=? ORDER BY case_id,repeat_no',job.id,project)).map(viewAttempt)});
 if(['/pause','/resume'].includes(suffix)&&method==='POST'){
 const paused=suffix==='/pause';await db.prepare("UPDATE evo_objects SET payload=json_set(payload,'$.paused',json(?)) WHERE id=? AND project=?").bind(paused?'true':'false',job.id,project).run();
 return json({paused,notice:paused?'已暂停新任务领取，正在运行的对话继续保存。取消可停止剩余轮次。':'已恢复领取；预约任务仍按原定时间开始。'});
 }
 if(suffix==='/cancel'&&method==='POST'){await db.prepare("UPDATE evo_attempts SET status=CASE WHEN status='queued' THEN 'cancelled' ELSE 'uncertain' END,lease=NULL WHERE job=? AND project=? AND status IN ('queued','running')").bind(job.id,project).run();return json({ok:true,notice:'未开始项已取消；运行中的业务可能已执行，请检查原系统。'})}
 if(suffix==='/offline'&&method==='POST'){
 const data=await body(request);need(data.schema==='evo-offline-results-v1'&&data.project_id===project&&data.job_id===job.id&&data.dataset_version===job.dataset_version,'结果包与当前项目、任务或题库版本不匹配');need(Array.isArray(data.results)&&data.results.length<=500,'结果包格式无效');
 const statements=[];for(const item of data.results){const row=await one(db,'SELECT * FROM evo_attempts WHERE id=? AND job=? AND project=?',item.attempt_id,job.id,project);need(row&&row.case_id===item.case_id&&row.repeat_no===item.repeat,'执行标识不匹配');
 const result=clean(item.result),input=JSON.parse(row.input);need(result&&['completed','failed','uncertain'].includes(result.status)&&str(result.agent_version,200)&&str(result.conversation_id,200),'结果缺少状态、版本或会话');
 if(result.status==='completed')need(workbenchDialogueMatches(input,result.turns)&&result.turns.every(t=>str(t.answer,100000)),'离线回答与原问题轮次不匹配');
 result.source='offline_uploaded_unverified';const digest=await hash(JSON.stringify(result));if(row.result_hash){need(row.result_hash===digest,'该执行已保存不同结果，禁止覆盖',409);continue}need(['queued','uncertain','cancelled'].includes(row.status),'运行中请先停止连接器并确认原业务结果',409);
 statements.push(db.prepare('UPDATE evo_attempts SET result=?,result_hash=?,status=?,lease=NULL WHERE id=? AND result_hash IS NULL AND status IN (\'queued\',\'uncertain\',\'cancelled\')').bind(JSON.stringify(result),digest,result.status,row.id));}
 if(statements.length)await db.batch(statements);return json({accepted:statements.length,source:'offline_uploaded_unverified'});
 }
 if(suffix==='/dispatch'&&method==='POST'){
 const data=await body(request),connection=await object(db,job.connection,project,'connection');need(connection.kind==='http','此连接需要客户侧连接器');
 const target=new URL(connection.url),allowed=(env.EVO_HTTP_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
 need(target.protocol==='https:'&&allowed.includes(target.origin),'在线直连只对管理员批准的 HTTPS 域名开放；此地址可用客户侧连接器调用',422);
 const row=await one(db,"UPDATE evo_attempts SET status='running',lease_until=? WHERE id=(SELECT id FROM evo_attempts WHERE job=? AND project=? AND status='queued' AND job IN (SELECT id FROM evo_objects WHERE kind='job' AND COALESCE(json_extract(payload,'$.paused'),0)=0 AND (json_extract(payload,'$.not_before') IS NULL OR json_extract(payload,'$.not_before')<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))) ORDER BY created,id LIMIT 1) AND status='queued' RETURNING *",Date.now()+240000,job.id,project);if(!row)return json({attempt:null});
 const conversation=ident('conversation'),turns=[],history=[];let session=conversation,result;
 const get=(value,path)=>path.split('.').reduce((v,k)=>v&&typeof v==='object'?v[k]:undefined,value);
 try{for(const [i,t]of JSON.parse(row.input).turns.entries()){
 await db.prepare("UPDATE evo_attempts SET lease_until=? WHERE id=? AND status='running'").bind(Date.now()+240000,row.id).run();const current=await one(db,'SELECT status FROM evo_attempts WHERE id=?',row.id);need(current.status==='running','任务已取消',409);
 const message=workbenchTurnMessage(t,turns.at(-1)?.answer||'');
 const response=await fetch(connection.url,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(60000),headers:{'Content-Type':'application/json',...(data.agent_token?{Authorization:'Bearer '+data.agent_token}:{})},body:JSON.stringify({message,conversation_id:session,history,turn_index:i+1})});
 need(response.ok,'业务调用未成功');const output=await body(response),answer=get(output,connection.answer_path);need(str(answer,100000),'业务响应没有有效回答');session=get(output,connection.session_path)||session;turns.push({question:message,answer,steps:output.steps||[],usage:output.usage||null});history.push({role:'user',content:message},{role:'assistant',content:answer});}
 result={status:'completed',turns,conversation_id:session,agent_version:job.agent_version,version_source:'user_declared',source:'platform_http',usage_source:'agent_reported_unverified'};
 }catch{result={status:'uncertain',turns,conversation_id:session,agent_version:job.agent_version,error:'业务结果待确认，未自动重试。请在原系统核对执行情况。',source:'platform_http'}}
 const saved=await one(db,'UPDATE evo_attempts SET result=?,result_hash=?,status=? WHERE id=? AND status=\'running\' AND result_hash IS NULL RETURNING id',JSON.stringify(clean(result)),await hash(JSON.stringify(clean(result))),result.status,row.id);if(!saved)throw new Fault(409,'任务状态已改变，请核对业务结果');return json({attempt:row.id,status:result.status});
 }
 if(suffix==='/bundle'&&method==='GET')return json({schema:'evo-execution-v1',project_id:project,job_id:job.id,dataset_version:job.dataset_version,agent_version:job.agent_version,attempts:(await all(db,'SELECT id,input,repeat_no FROM evo_attempts WHERE job=? AND project=?',job.id,project)).map(r=>({attempt_id:r.id,...JSON.parse(r.input),repeat:r.repeat_no}))});
 if(suffix==='/export'&&method==='GET'){const ds=await object(db,job.dataset,project,'dataset');const rows=await all(db,'SELECT * FROM evo_attempts WHERE job=? AND project=?',job.id,project);return json({schema:'evo-results-v1',project_id:project,job_id:job.id,dataset_version:job.dataset_version,agent_version:job.agent_version,records:rows.filter(r=>r.result).flatMap(r=>{const result=JSON.parse(r.result),c=ds.cases.find(c=>c.case_id===r.case_id);return (result.turns||[]).map((t,i)=>({case_id:r.case_id,conversation_id:r.id,turn:i+1,question:t.question,answer:t.answer,reference:c?.reference||'',expectation:c?.expected||{},trace:t.steps||[],version:job.dataset_version,attempt_id:r.id,agent_version:result.agent_version,execution_status:result.status,source:result.source||'unknown',evidence_verified:false}))})})}
 }
 throw new Fault(404,'操作不存在');
 }catch(e){return json({detail:e instanceof Fault?e.message:'任务服务暂时不可用，已保存的记录保留'},e instanceof Fault?e.status:500)}
}
