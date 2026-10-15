import { personalMode, publicMode } from './publicSnapshot'
import { loadReports } from './reportClient'
type Row=Record<string,any>
let database:Promise<IDBDatabase>|undefined
async function db(){return database ||= new Promise((resolve,reject)=>{const r=indexedDB.open('agent-evo-decisions-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('reviews',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('审核记录存储不可用'))})}
export async function decisionReviews(source:string,batchId:string,body?:Row):Promise<{items:Row[]}>{
  if(publicMode){if(body)throw Error('公开示例为只读，不能修改历史审核');return {items:[]}}
  if(!personalMode){const token=sessionStorage.getItem('evo_access_token');const r=await fetch(`/api/decisions/${source}/${encodeURIComponent(batchId)}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-EVO-Decisions':'1',...(token?{'X-EVO-Token':token}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Error(typeof value.detail==='string'?value.detail:'审核保存失败');return body?decisionReviews(source,batchId):value}
  const d=await db()
  if(body){const {snapshot}=await loadReports(source,batchId);if(body.snapshot_id!==snapshot.snapshot_id)throw Error('评分已变化，请刷新后重新审核');if(!snapshot.units.some((u:Row)=>u.id===body.record_id))throw Error('记录不属于此批次');if(!body.reason?.trim()||!['confirmed','disputed','insufficient','planned','retest'].includes(body.status))throw Error('请选择审核状态并填写依据');const row={...body,id:'review_'+crypto.randomUUID(),source,batch_id:batchId,created_at:new Date().toISOString(),actor:'当前浏览器用户'};await new Promise<void>((resolve,reject)=>{const t=d.transaction('reviews','readwrite');t.objectStore('reviews').add(row);t.oncomplete=()=>resolve();t.onerror=()=>reject(Error('审核保存失败'));t.onabort=t.onerror})}
  const rows=await new Promise<Row[]>((resolve,reject)=>{const r=d.transaction('reviews').objectStore('reviews').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('审核读取失败'))})
  return {items:rows.filter(r=>r.source===source&&r.batch_id===batchId).sort((a,b)=>b.created_at.localeCompare(a.created_at))}
}
