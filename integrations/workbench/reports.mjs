import {reportClean,validateReport} from '../../web/src/reportCore.mjs';
import reportPolicy from '../../src/agent_evo/report_policy.json' with {type:'json'};
// Stateless report editor: no server key, no Agent execution, no persistent uploads.
export async function generateEvaluationReport(request) {
  const reply=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if(request.method!=='POST'||request.headers.get('X-EVO-Reports')!=='1')return reply({detail:'请从报告入口提交'},403);
  const key=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');
  if(key.length<10||key.length>512||/[\r\n]/.test(key))return reply({detail:'百炼 Key 无效'},422);
  let body;
  try{
    const reader=request.body?.getReader(),chunks=[];let size=0;
    if(reader)try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>512*1024)return reply({detail:'报告材料过大'},413);chunks.push(r.value)}}finally{await reader.cancel()}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length}body=JSON.parse(new TextDecoder().decode(bytes));
    if(!/^qwen[\w.:-]{0,95}$/.test(body.model||'')||!body.material?.metrics||!Array.isArray(body.material.records)||body.material.records.length>24||!body.material.coverage||JSON.stringify(body.material).length>85000)throw Error();
    for(const r of body.material.records)if(typeof r.id!=='string'||!Array.isArray(r.evidence)||r.evidence.some(e=>typeof e.ref!=='string'||typeof e.text!=='string'||e.text.length>900))throw Error();
  }catch{return reply({detail:'报告材料格式不完整'},422)}
  const material=reportClean(body.material),result={business_calls:0,model:body.model,usage:[],responses:[],template_version:reportPolicy.version,ai_coverage:material.coverage,human_review_required:true,quota_verified:false,provenance:'browser_supplied_evidence'};
  const messages=[{role:'system',content:reportPolicy.system+'\n本次 metric_refs 只允许以下键：'+Object.keys(material.metrics).filter(k=>material.metrics[k]===null||typeof material.metrics[k]!=='object').join(',')+'。critical 和 profiles 是对象，不能作为 metric_refs；改用对应原文证据。'},{role:'user',content:JSON.stringify(material)}];
  for(let attempt=0;attempt<2;attempt++){
    const started=Date.now(),usage={attempt:attempt+1,request_id:null,usage:null,status:'requesting'};result.usage.push(usage);
    try{
      const response=await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({model:body.model,temperature:0,enable_thinking:false,max_tokens:6500,response_format:{type:'json_object'},messages}),redirect:'manual',signal:AbortSignal.timeout(120000)});
      const value=await response.json();Object.assign(usage,{request_id:value.id||response.headers.get('x-request-id'),usage:value.usage,http_status:response.status,latency_ms:Date.now()-started,status:'received'});
      if(!response.ok){const code=String(value.error?.code||'provider_error').slice(0,100);return reply({...result,status:'failed',error_code:code,error:code.includes('FreeTierOnly')?'免费额度已用尽，已停止；基础报告保留。':'百炼请求失败，请检查模型权限、额度及 Key。基础报告保留。'})}
      try{const text=value.choices[0].message.content;result.responses.push({attempt:attempt+1,content:reportClean(text.replaceAll(key,'[凭证已移除]'))});return reply({...result,status:'completed',report:validateReport(JSON.parse(text),material)})}catch(error){usage.status='validation_failed';usage.validation_error=String(error.message||'报告格式或证据引用校验未通过').slice(0,2400);messages.push({role:'assistant',content:value.choices?.[0]?.message?.content||'{}'},{role:'user',content:'请修复上次输出：'+usage.validation_error+'。重新输出全部五个数组；每条至少有有效指标键或证据，issues 和 recommendations 必须有 evidence。引用只能从给定 evidence 中逐字选择，不增加不存在的 ref，不省略 Markdown 和标点。text 不写阿拉伯数字，也不重复系统禁止的断言短语（包括否定句）。不得删掉无关的有效章节。'});}
    }catch{Object.assign(usage,{status:'request_failed',latency_ms:Date.now()-started});return reply({...result,status:'failed',error:'报告请求未取得有效响应，未自动重试；基础报告保留。'})}
  }
  return reply({...result,status:'failed',error:'两次输出均未通过校验，未采纳 AI 报告；基础报告保留。'});
}
