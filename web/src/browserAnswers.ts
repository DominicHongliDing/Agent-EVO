import { personalRequest } from './personalWorkspace'
import { hostedMode } from './publicSnapshot'
import { parseAnswerFile, normalizeAnswers } from './browserAnswerFiles'
import { reviewMaterial, reviewSegments } from './answerReview.mjs'
type Row = Record<string,any>
type State = {imports:Record<string,Row>;batches:Row[];records:Record<string,Row>}
const stamp=()=>new Date().toISOString(),uid=(p:string)=>p+'_'+crypto.randomUUID().replace(/-/g,''),lockName='evo-answer-data',executionName='evo-answer-judge'
let key='',model='qwen3.6-flash',database:Promise<IDBDatabase>|undefined,pumping=false
const status=()=>({configured:!!key,model,provider:'阿里云百炼',key_storage:'page_memory',business_calls:0})
async function hash(value:ArrayBuffer|string){const bytes=typeof value==='string'?new TextEncoder().encode(value):value;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('')}
const held=async()=>Boolean((await navigator.locks?.query())?.held?.some(l=>l.name===executionName))
async function db(){return database ||= new Promise((resolve,reject)=>{const r=indexedDB.open('agent-evo-answers-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('data');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('无法打开浏览器存储'))})}
async function data<T>(fn:(state:State)=>Promise<T>|T,write=false):Promise<T>{
  if(!navigator.locks)throw Error('浏览器不支持独立工作区锁，请使用近期版本 Chrome 或 Edge')
  return navigator.locks.request(lockName,async()=>{const database=await db();const state=await new Promise<State>((resolve,reject)=>{const r=database.transaction('data').objectStore('data').get('answers');r.onsuccess=()=>resolve(r.result||{imports:{},batches:[],records:{}});r.onerror=()=>reject(Error('读取浏览器记录失败'))});const result=await fn(state);if(write)await new Promise<void>((resolve,reject)=>{const t=database.transaction('data','readwrite');t.objectStore('data').put(state,'answers');t.oncomplete=()=>resolve();t.onerror=()=>reject(Error('浏览器存储空间不足，请导出记录'));t.onabort=t.onerror});return structuredClone(result)})
}
let recovered:Promise<void>|undefined
function recover(){return recovered ||= (async()=>{if(await held())return;await data(s=>{for(const r of Object.values(s.records))for(const a of r.assessments)if(['queued','running'].includes(a.status)){a.status='interrupted';a.finished_at=stamp();a.result={...a.result,quality:'unjudged',reason:'页面已关闭或刷新；已保存的回答与评分保留。重新评分需要手动发起。'}}},true)})()}
const detail=(s:State,id:string):Row=>{const r=s.records[id];if(!r)throw Error('回答记录不存在');return {...r,original_fields:s.imports[r.source.import_id].rows.filter((x:Row)=>r.source_lines.includes(x.line))}}
const batch=(s:State,id:string)=>{const b=s.batches.find(b=>b.batch_id===id);if(!b)throw Error('批次不存在');return b}
const batchView=(s:State,b:Row)=>({...b,total:b.record_ids.length,records:b.record_ids.map((id:string)=>{const r=s.records[id],a=r.assessments[0],v=a?.result||{};return {record_id:id,question:r.turns[0].question,turn_count:r.turns.length,status:a?.status||'not_started',quality:v.quality||'unjudged',critical_count:v.critical_findings?.length||0}})})
async function preview(s:State,id:string,p:Row){const raw=s.imports[id];if(!raw)throw Error('文件不存在');let dataset:Row|undefined,cases:Row[]=[];if(p.dataset_id){dataset=(await personalRequest<{items:Row[]}>('/datasets')).items.find(d=>d.dataset_id===p.dataset_id);if(!dataset)throw Error('测试集不可用');cases=(await personalRequest<{items:Row[]}>('/cases')).items.filter(c=>c.dataset_id===p.dataset_id)}const value=normalizeAnswers(raw,p,dataset,cases);return {...value,judge_segments:value.records.reduce((n,r)=>n+reviewSegments(r).length,0)}}

export async function browserAnswerRequest<T>(path:string,init:RequestInit={}):Promise<T>{
  await recover();const method=init.method||'GET',url=new URL(path,location.origin),p=url.pathname,body=typeof init.body==='string'?JSON.parse(init.body):{},parts=p.split('/')
  if(p==='/judge'){if(method==='POST'){if(typeof body.api_key!=='string'||body.api_key.trim().length<10||!/^qwen[\w.:-]{0,95}$/.test(body.model||''))throw Error('请填写有效百炼 Key 与 Qwen 模型名');key=body.api_key.trim();model=body.model}return status() as T}
  if(p==='/export')return await data(s=>({format:'agent-evo-imported-answers-v1',exported_at:stamp(),batches:s.batches,records:s.records,imports:Object.values(s.imports).map(({file,...r})=>r)})) as T
  if(p==='/imports'&&method==='POST'){const file=(init.body as FormData)?.get('file');if(!(file instanceof File))throw Error('请选择文件');const parsed=await parseAnswerFile(file),raw={...parsed,import_id:uid('import'),sha256:await hash(await file.arrayBuffer()),created_at:stamp(),file};await data(s=>{s.imports[raw.import_id]=raw},true);const {file:_,...result}=raw;return result as T}
  if(method!=='GET'&&!pumping&&await held())throw Error('另一个页面正在评分，请在原页面操作或等待完成')
  const result=await data(async s=>{
    if(parts[1]==='imports'&&parts[3]==='preview')return preview(s,parts[2],body)
    if(parts[1]==='imports'&&parts[3]==='commit'){
      if(!body.reviewed_deidentified)throw Error('请确认已脱敏');const parsed=await preview(s,parts[2],body);if(!parsed.valid)throw Error('仍有逐行问题，请返回预览修正')
      const fingerprint=await hash(JSON.stringify(parsed.records.map(r=>({...r,source:{...r.source,import_id:undefined}})))),old=s.batches.find(b=>b.fingerprint===fingerprint)
      if(old){if(old.deleted_at)throw Error('相同内容已在回收站，请先恢复');return {batch_id:old.batch_id,reused:true}}
      const id=uid('answers'),record_ids=parsed.records.map(r=>{const rid=uid('answer');s.records[rid]={...r,record_id:rid,batch_id:id,assessments:[]};return rid})
      s.batches.unshift({batch_id:id,name:String(body.name||'导入回答').trim().slice(0,120),created_at:stamp(),pinned:0,deleted_at:null,fingerprint,record_ids});return {batch_id:id,reused:false}
    }
    if(p==='/batches')return {items:s.batches.filter(b=>!!b.deleted_at===(url.searchParams.get('deleted')==='true')).sort((a,b)=>b.pinned-a.pinned||b.created_at.localeCompare(a.created_at)).map(b=>batchView(s,b))}
    if(parts[1]==='batches'){
      const b=batch(s,parts[2]);if(parts[3]==='judge'){
        if(!key)throw Error('请先填写裁判 Key');if(b.deleted_at)throw Error('请先恢复批次');const ids=body.record_ids||b.record_ids;if(!Array.isArray(ids)||ids.some(id=>!b.record_ids.includes(id)))throw Error('所选记录不属于本批次');let queued=0
        for(const id of new Set<string>(ids)){const r=s.records[id];if(r.assessments.some((a:Row)=>['queued','running'].includes(a.status)))continue;r.assessments.unshift({assessment_id:uid('assessment'),created_at:stamp(),status:'queued',result:{business_calls:0}});queued++}return {queued}
      }
      if(parts[3]==='manage'){const jobs=b.record_ids.flatMap((id:string)=>s.records[id].assessments);if(body.action==='delete'&&jobs.some((a:Row)=>['running','queued'].includes(a.status)))throw Error('请等待评分完成或取消排队项');if(['pin','unpin'].includes(body.action))b.pinned=+(body.action==='pin');else if(['delete','restore'].includes(body.action))b.deleted_at=body.action==='delete'?stamp():null;else if(body.action==='cancel'){for(const a of jobs)if(a.status==='queued'){a.status='cancelled';a.finished_at=stamp()}}else throw Error('操作不支持');return {updated:true}}
      return batchView(s,b)
    }
    if(parts[1]==='records'){const r=detail(s,parts[2]);if(parts[3]==='compare'){const right=detail(s,url.searchParams.get('other')||'');if(JSON.stringify(r.turns.map((t:Row)=>t.question))!==JSON.stringify(right.turns.map((t:Row)=>t.question)))throw Error('完整用户问题不同，不能作为同题对比');return {left:r,right}}return r}
    if(p==='/regression'){
      const entries=Object.entries(body.expectations||{});if(!body.confirmed||!entries.length||entries.length>100||entries.some(([,v])=>typeof v!=='string'||!v.trim()||v.length>4000))throw Error('请填写并确认所选问题的期望')
      const profile=body.profile||'generic';if(!['generic','clinical'].includes(profile))throw Error('用途不支持');let cases:Row[]=[],version='v1'
      if(body.dataset_id){const old=(await personalRequest<{items:Row[]}>('/datasets')).items.find(d=>d.dataset_id===body.dataset_id);if(!old||old.profile!==profile)throw Error('测试集不兼容');cases=(await personalRequest<{items:Row[]}>('/cases')).items.filter(c=>c.dataset_id===body.dataset_id).map(c=>({...c,case_id:c.source_case_id||c.case_id}));version='v'+(Number(old.version.slice(1))+1)}
      for(const [id,expected] of entries){const r=detail(s,id);if(r.turns.length>(profile==='clinical'?8:40))throw Error('官网 Clinical 运行最多 8 轮，请整理完整回归场景');cases.push({case_id:uid('imported'),message:r.turns[0].question,title:r.turns[0].question.slice(0,80),synthetic:true,turns:r.turns.length>1?r.turns.map((t:Row)=>({message:t.question})):[],expected:{behavior_expectation:expected,imported_answer_record:id,source_file_sha256:r.source.sha256}})}
      return personalRequest('/datasets',{method:'POST',body:JSON.stringify({name:body.name,profile,version,filename:'answer-regression.json',content:JSON.stringify(cases),description:'期望由用户确认，工程草案；源回答保留在个人浏览器。'})})
    }
    throw Error('回答评测操作不支持')
  },method!=='GET'&&!p.endsWith('/preview'))
  if(p.endsWith('/judge')&&method==='POST')void pump()
  return result as T
}
export async function browserOriginalFile(id:string):Promise<Blob>{return data(s=>{const file=s.imports[id]?.file;if(!file)throw Error('原文件不可用');return file})}
// Credentials stay in this module's memory; callers receive only a request header.
export function answerReportAuthorization(){return key ? 'Bearer '+key : ''}
async function pump(){
  if(pumping)return;pumping=true
  try{await navigator.locks.request(executionName,{ifAvailable:true},async lock=>{if(!lock)return
    while(true){const job=await data(s=>{for(const r of Object.values(s.records)){const a=r.assessments.find((a:Row)=>a.status==='queued');if(a){a.status='running';return {record:r,assessment:a}}}return null},true);if(!job)break
      const credentials={key,model},chunks=reviewSegments(job.record),results:Row[]=[];let failure=false
      const update=async(status:string,result:Row)=>data(s=>{const a=s.records[job.record.record_id].assessments.find((a:Row)=>a.assessment_id===job.assessment.assessment_id);a.status=status;a.result=result;if(status!=='running')a.finished_at=stamp()},true)
      try{
        for(let i=0;i<chunks.length;i++){
          const record={turns:chunks[i].map(t=>({turn:t.turn,question:t.question,answer:t.answer,reference:t.reference,linked_case:t.linked_case})),partial_context:i>0}
          if(JSON.stringify(reviewMaterial(record)).length>95000){results.push({status:'unjudged',reason:'单轮材料超过评分范围，未截断原文',turns:[],judge_calls:0});continue}
          const response=await fetch(hostedMode?'/api/evaluation/judge':'/api/answers/visitor-judge',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+credentials.key,'X-EVO-Answers':'1'},body:JSON.stringify({record,model:credentials.model}),signal:AbortSignal.timeout(190000)})
          const r=await response.json().catch(()=>({detail:'评分响应不是有效 JSON'}));if(!response.ok)throw Error(typeof r.detail==='string'?r.detail:'评分请求失败')
          results.push({...r.result,status:r.status,turn_range:[chunks[i][0].turn,chunks[i].slice(-1)[0].turn]});await update('running',{summary:`已检查 ${i+1}/${chunks.length} 段；原文完整保留`,segments:results,judge_calls:results.reduce((n,r)=>n+(r.judge_calls||0),0),quality:'unjudged'})
        }
      }catch{failure=true}
      const scored=results.flatMap(r=>r.turns||[]),complete=!failure&&results.length===chunks.length&&results.every(r=>r.status==='completed')
      const result=chunks.length===1&&complete?results[0]:{summary:`已取得 ${scored.length}/${job.record.turns.length} 轮评分。${chunks.length>1?'长对话分段检查，跨段上下文待完整复核。':''}${failure?'评分请求失败，请检查 Key、额度或网络后手动重试。':''}`,quality:results.some(r=>r.quality==='fail')?'fail':'unjudged',turns:scored,critical_findings:results.flatMap(r=>r.critical_findings||[])}
      await update(failure?'failed':complete?'completed':'unjudged',{...result,segments:results,judge_calls:results.reduce((n,r)=>n+(r.judge_calls||0),0),usage:results.flatMap(r=>r.usage||[]),business_calls:0,root_cause_status:'not_assessed',execution_verified:false})
    }
  })}finally{pumping=false}
}
