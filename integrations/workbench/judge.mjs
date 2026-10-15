import {reviewMaterial,validateReview,canonicalizeCitations} from '../../web/src/answerReview.mjs';
import policy from '../../web/src/answerPolicy.json' with {type:'json'};
export async function judgeWorkbench(record,key,model='qwen3.8-max-0902'){
 if(typeof key!=='string'||key.length<10||key.length>512)throw Error('请提供百炼评审 Key');
 if(!/^qwen[\w.:-]{0,95}$/.test(model))throw Error('模型名称无效');
 const material=reviewMaterial(record),system=policy.policy+'\n每项引用选择原文中的短句，建议 10–50 字，严格保留 Markdown 符号、标点和空格。不要为了证据摘录全文。\n分数锚点：'+JSON.stringify(policy.anchors),usage=[],validation_errors=[];
 if(JSON.stringify(material).length>75000)return {status:'unjudged',result:{reason:'材料超出完整评审范围，原文未截断，请人工审核。'}};
 const messages=[{role:'system',content:system},{role:'user',content:JSON.stringify({records:material,turn_numbers:record.turns.map(t=>t.turn),partial_context:false})}];
 for(let i=0;i<2;i++){
 const response=await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(120000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({model,temperature:0,enable_thinking:false,response_format:{type:'json_object'},max_tokens:12000,messages})});
 if(!response.ok){const error=await response.json().catch(()=>({}));return {status:'failed',result:{model,usage,http_status:response.status,error_code:String(error.error?.code||'unknown').slice(0,100),reason:'百炼评审失败，未记作通过；请检查额度和模型权限。'}}}
 const out=await response.json();usage.push({request_id:out.id,usage:out.usage,stage:'answer_judging'});
 try{const normalized=canonicalizeCitations(JSON.parse(out.choices[0].message.content),record);return {status:'completed',result:{...validateReview(normalized.data,record),citation_repairs:normalized.repairs,model,usage,validation_errors,rubric_version:'workbench-answer-v1',business_calls:0}}}catch(e){validation_errors.push({error:e.message,output:out.choices?.[0]?.message?.content||''});messages.push({role:'assistant',content:out.choices?.[0]?.message?.content||'{}'},{role:'user',content:'校验失败：'+e.message+'。请按原轮次及原文证据重新输出完整结果。dimensions 必须为四个对象的数组，证据 quote 必须是对应 ref 的连续原文，不得改写、拼接或用省略号。'})}
 }
 return {status:'unjudged',result:{model,usage,validation_errors,reason:'两次输出未通过引用校验，保留待审核。'}};
}
