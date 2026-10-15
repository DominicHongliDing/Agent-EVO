import { api } from './api'
import { answerParts } from './replayPresentation'
import { answersApi } from './answerClient'
import { personalMode, publicMode, hostedMode } from './publicSnapshot'
import { reportAnswerUnit, reportMetrics, reportClean, reportCanonical, reportMaterial, validateReport } from './reportCore.mjs'
import policy from '../../src/agent_evo/report_policy.json'
type Row=Record<string,any>
let reportKey='',reportModel=policy.model
const stamp=()=>new Date().toISOString()
const activeStatuses=['queued','interpreting','validating']
let database:Promise<IDBDatabase>|undefined
async function db(){return database ||= new Promise((resolve,reject)=>{const r=indexedDB.open('agent-evo-reports-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('reports',{keyPath:'report_id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('报告存储不可用'))})}
async function savedReports():Promise<Row[]>{const d=await db();return new Promise((resolve,reject)=>{const r=d.transaction('reports').objectStore('reports').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('报告读取失败'))})}
async function put(report:Row){const d=await db();await new Promise<void>((resolve,reject)=>{const t=d.transaction('reports','readwrite');t.objectStore('reports').put(report);t.oncomplete=()=>resolve();t.onerror=()=>reject(Error('报告保存失败，请检查浏览器存储空间'));t.onabort=t.onerror})}
async function authorization(){return reportKey?'Bearer '+reportKey:(await import('./browserAnswers')).answerReportAuthorization()}
async function local<T>(path:string,init:RequestInit={}):Promise<T>{const token=sessionStorage.getItem('evo_access_token');const res=await fetch('/api/reports'+path,{...init,headers:{'Content-Type':'application/json','X-EVO-Reports':'1',...(token?{'X-EVO-Token':token}:{}),...init.headers},cache:'no-store'});const body=await res.json().catch(()=>({detail:'报告服务响应无效，请启动新版后端'}));if(!res.ok)throw Error(body.detail||'报告请求失败');return body}
async function browserSnapshot(source:string,id:string){
  let units:Row[]=[],batch:Row,repetitions=1
  if(source==='answers'){batch=await answersApi<Row>('/batches/'+id);units=await Promise.all(batch.records.map(async(r:Row)=>reportAnswerUnit(await answersApi('/records/'+r.record_id))))}
  else{
    batch=await api<Row>('/batches/'+id);repetitions=batch.repetitions||1
    // Visitor runs do not yet have native independent quality grades. Keep them unknown.
    units=await Promise.all(batch.runs.map(async(r:Row)=>{const run=await api<Row>('/runs/'+r.run_id),turns=run.output?.conversation_turns?.length?run.output.conversation_turns:[{turn_index:1,message:run.case?.message||'',output:run.output}];return {id:r.run_id,question_key:r.case_id+'|'+(run.case_sha256||r.run_id),profile:'native-'+(turns.length>1?'multi':'single'),dimensions:Object.fromEntries((turns.length>1?['evidence_consistency','coverage','context','clarity']:['evidence_consistency','coverage','clarity']).map(d=>[d,null])),title:run.case?.message||r.title||r.case_id,turn_count:Math.max(1,turns.length),execution:run.status,assessment_id:null,assessment_status:'not_started',rubric:'无独立维度评分',quality:'unjudged',critical:(run.verdicts||[]).filter((v:Row)=>v.critical&&v.result==='fail').map((v:Row)=>({kind:'rule',reason:v.rationale,evidence:v.evidence||[]})),low_turns:[],evidence:turns.flatMap((t:Row,i:number)=>[{ref:`turn:${i+1}:user`,text:t.message||''},{ref:`turn:${i+1}:assistant`,text:answerParts({run_id:run.run_id,status:run.status,output:t.output}).map(p=>p.content).join('\n\n')}]),source:{agent:run.agent,agent_id:run.agent_id,dataset_id:r.dataset_id,case_id:r.case_id,versions:run.version},repeat_eligible:false,retry:!!r.retry_of,trace_coverage:'unverified',usage:run.model_evidence||null}}))
  }
  const snap=reportClean({version:policy.version,scoring_contract:{version:'evo-score-v1',weights:'equal_applicable_dimensions',selection:'latest_assessment_no_fallback',unknown:'no_composite',aggregation:'per_question_macro'},source,batch_id:id,name:batch.name||batch.label,units,metrics:reportMetrics(units,repetitions),provenance:publicMode?'published_snapshot':'browser_saved_records'})
  snap.snapshot_id=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(reportCanonical(snap))))].map(b=>b.toString(16).padStart(2,'0')).join('');return snap
}
export async function reportConfig(body?:Row):Promise<Row>{
  if(!personalMode&&!publicMode)return local('/config',body?{method:'POST',body:JSON.stringify(body)}:{})
  if(body){if(!/^qwen[\w.:-]{0,95}$/.test(body.model))throw Error('报告模型格式无效');reportModel=body.model;if(body.api_key)reportKey=body.api_key.trim()}
  return {configured:!!await authorization(),model:reportModel,quota_verified:false}
}
export async function loadReports(source:string,id:string):Promise<Row>{
  if(!personalMode&&!publicMode)return local('/'+source+'/'+id)
  const snapshot=await browserSnapshot(source,id),held=(await navigator.locks.query()).held||[]
  const reports=(await savedReports()).filter(r=>r.source===source&&r.batch_id===id).sort((a,b)=>b.created_at.localeCompare(a.created_at))
  for(const r of reports)if(activeStatuses.includes(r.status)&&!held.some(l=>l.name==='evo-report-'+r.report_id)){r.status='interrupted';r.result={...r.result,error:'页面已关闭或刷新，生成状态未知；基础报告与历史版本保留。'};await put(r)}
  return {snapshot,reports:reports.map(r=>({...r,stale:r.snapshot_id!==snapshot.snapshot_id})),watch:false}
}
export async function reportSnapshot(id:string){if(!personalMode&&!publicMode)return local<Row>('/saved/'+id+'/snapshot');const r=(await savedReports()).find(r=>r.report_id===id);if(!r)throw Error('历史报告不存在');return r.snapshot}
export async function watchReport(source:string,id:string,enabled:boolean){return local('/'+source+'/'+id+'/watch?enabled='+enabled,{method:'POST'})}
export async function createReport(source:string,id:string,regenerate=false):Promise<Row>{
  if(!personalMode&&!publicMode)return local('/'+source+'/'+id,{method:'POST',body:JSON.stringify({regenerate})})
  if(publicMode)throw Error('公开历史仅供查看，请切换到个人工作区生成报告')
  const auth=await authorization();if(!auth)throw Error('请先配置百炼 Key')
  return navigator.locks.request('evo-report-create',async()=>{
    const snapshot=await browserSnapshot(source,id)
    if(snapshot.units.some((u:Row)=>['queued','running'].includes(u.execution)||['queued','running'].includes(u.assessment_status)))throw Error('请等待执行与评分结束')
    const old=(await savedReports()).filter(r=>r.snapshot_id===snapshot.snapshot_id&&r.model===reportModel).sort((a,b)=>b.created_at.localeCompare(a.created_at))[0]
    if(old&&(!regenerate||activeStatuses.includes(old.status)))return {report_id:old.report_id}
    const row={report_id:'report_'+crypto.randomUUID(),source,batch_id:id,snapshot,snapshot_id:snapshot.snapshot_id,model:reportModel,status:'queued',created_at:stamp(),result:{}} as Row
    await put(row)
    // Acquire the execution lock before returning, so recovery cannot mistake a new job for an abandoned one.
    let ready!:()=>void;const started=new Promise<void>(r=>{ready=r})
    void navigator.locks.request('evo-report-'+row.report_id,async()=>{ready();try{row.status='interpreting';await put(row);const material=reportMaterial(snapshot),res=await fetch(hostedMode?'/api/evaluation/report':'/api/reports/visitor/report/generate',{method:'POST',headers:{'Content-Type':'application/json','X-EVO-Reports':'1',Authorization:auth},body:JSON.stringify({material,model:row.model}),signal:AbortSignal.timeout(260000)});const result=await res.json();if(!res.ok)throw Error(result.detail||'报告请求失败');row.status='validating';await put(row);if(result.status==='completed')validateReport(result.report,material);row.result=result;row.status=result.status}catch{row.status='failed';row.result={error:'报告请求或引用校验失败，未采纳 AI 内容；可手动重试，基础报告保留。',business_calls:0}}finally{row.updated_at=stamp();await put(row)}})
    await started;return {report_id:row.report_id}
  })
}
