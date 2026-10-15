// Opt-in trace sink. Never calls the Agent and never upgrades uploaded evidence.
import {reportCanonical} from '../../web/src/reportCore.mjs';
const syncHash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(reportCanonical(value))))].map(b=>b.toString(16).padStart(2,'0')).join('');
const syncAttrs=values=>Object.entries(values).map(([key,value])=>({key,value:typeof value==='boolean'?{boolValue:value}:{stringValue:typeof value==='string'?value:JSON.stringify(value)}}));
export async function prepareTraceSync(attempt,unit,job){
 const trace=(await syncHash(attempt.id)).slice(0,32),root=(await syncHash(attempt.id+':root')).slice(0,16);
 const record={attempt_id:attempt.id,job_id:job.id,case_id:attempt.case_id,dataset_version:job.dataset_version,version:job.agent_version,result:attempt.result,assessment:unit};
 const revision=await syncHash(record),at=attempt.created,start=String(BigInt(Date.parse(at))*1000000n),end=String((BigInt(Date.parse(at))+BigInt(Math.max(0,Math.round(attempt.result?.duration_ms||0))))*1000000n);
 const common={'langfuse.trace.name':unit.title,'langfuse.trace.public':false,'langfuse.session.id':attempt.result?.conversation_id||attempt.id,'langfuse.environment':'evo-workbench','langfuse.experiment.id':job.id,'langfuse.experiment.name':job.name,'langfuse.experiment.dataset.id':job.dataset_version,'langfuse.experiment.item.id':attempt.case_id,'langfuse.experiment.item.root_observation_id':root};
 const spans=[{traceId:trace,spanId:root,name:unit.title,kind:1,startTimeUnixNano:start,endTimeUnixNano:end,attributes:syncAttrs({...common,'langfuse.observation.type':'span','langfuse.observation.input':attempt.input,'langfuse.observation.output':record,'langfuse.observation.metadata.evo_revision':revision})}];
 for(const [i,turn] of (attempt.result?.turns||[]).entries())spans.push({traceId:trace,spanId:(await syncHash(attempt.id+':turn:'+i)).slice(0,16),parentSpanId:root,name:'第 '+(i+1)+' 轮回答与上报步骤',kind:1,startTimeUnixNano:start,endTimeUnixNano:start,attributes:syncAttrs({...common,'langfuse.observation.type':'span','langfuse.observation.input':turn.question,'langfuse.observation.output':turn,'langfuse.observation.metadata.timing':'individual_turn_timing_unavailable'})});
 const scores=[];
 for(const [name,value]of Object.entries(unit.dimensions||{}))if(typeof value==='number')scores.push({id:(await syncHash(attempt.id+':'+revision+':'+name)).slice(0,32),type:'score-create',timestamp:at,body:{id:(await syncHash(revision+':'+name)).slice(0,32),traceId:trace,observationId:root,name,value,dataType:'NUMERIC',comment:'EVO 已保存评分；每维 0–5。来源 '+unit.rubric,environment:'evo-workbench'}});
 return {revision,trace_id:trace,root_id:root,record,from_time:new Date(Date.parse(at)-1000).toISOString(),to_time:new Date(Date.parse(at)+86400000).toISOString(),otlp:{resourceSpans:[{resource:{attributes:syncAttrs({'service.name':'agent-evo-workbench'})},scopeSpans:[{scope:{name:'agent-evo'},spans}]}]},scores};
}
export async function sendTraceSync(payload,config,local=false,fetcher=fetch){
 const target=new URL(config.host);if(target.username||target.password||target.pathname!=='/'||target.search||target.hash)throw Error('同步地址必须为服务根地址');
 if(!(target.protocol==='https:'&&['cloud.langfuse.com','us.cloud.langfuse.com'].includes(target.hostname))&&!(local&&target.protocol==='http:'&&['localhost','127.0.0.1'].includes(target.hostname)))throw Error('公共站点仅开放官方云端目标；本机自建请从本地平台同步');
 if(!config.public_key||!config.secret_key)throw Error('请填写目标项目的同步凭证');
 const headers={Authorization:'Basic '+btoa(config.public_key+':'+config.secret_key),'Content-Type':'application/json'};
 async function call(path,data){const res=await fetcher(target.origin+'/api/public'+path,{method:data?'POST':'GET',headers,body:data?JSON.stringify(data):undefined,redirect:'manual',signal:AbortSignal.timeout(30000)});if(!res.ok)throw Error('轨迹服务返回 '+res.status+'，原记录保留');return res.json()}
 const ack=await call('/otel/v1/traces',payload.otlp);if(Number(ack.partialSuccess?.rejectedSpans||0))throw Error('目标仅接收部分轨迹，请重新同步');
 if(payload.scores.length){const ack=await call('/ingestion',{batch:payload.scores});if(ack.errors?.length)throw Error('目标未完整接收评分')}
 const params=new URLSearchParams({traceId:payload.trace_id,fromStartTime:payload.from_time,toStartTime:payload.to_time,limit:'1000',fields:'core,basic,io,metadata'});
 const observations=(await call('/v2/observations?'+params)).data||[],root=observations.find(x=>x.id===payload.root_id);
 const parsed=value=>{try{return typeof value==='string'?JSON.parse(value):value}catch{return value}};
 const expected=payload.otlp.resourceSpans[0].scopeSpans[0].spans;
 let intact=!!root&&await syncHash(parsed(root.output))===payload.revision;
 for(const span of expected){const item=observations.find(o=>o.id===span.spanId),output=span.attributes.find(a=>a.key==='langfuse.observation.output').value.stringValue;if(!item||await syncHash(parsed(item.output))!==await syncHash(parsed(output)))intact=false}
 let scores=[];if(payload.scores.length)scores=(await call('/v3/scores?'+new URLSearchParams({id:payload.scores.map(s=>s.body.id).join(','),limit:'100',fields:'details,subject'}))).data||[];
 const scoreMatch=payload.scores.every(s=>scores.some(r=>r.id===s.body.id&&r.name===s.body.name&&r.value===s.body.value));
 return {status:intact&&scoreMatch?'verified':'indexing',trace_id:payload.trace_id,observation_count:observations.length,score_count:scores.length,verified_at:intact&&scoreMatch?new Date().toISOString():null,notice:intact&&scoreMatch?'已从目标回读并核对原文与评分':'目标已接收，索引或回读尚未完整；稍后重试核验'};
}
