// Stateless BYOK endpoint. No shared credentials, conversations or upload storage.
async function judgeUploadedAnswers(request) {
  const safeHeaders={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
  const reply=(value,status=200)=>Response.json(value,{status,headers:safeHeaders});
  if(request.method!=='POST')return reply({detail:'Method not allowed'},405);
  if(request.headers.get('X-EVO-Answers')!=='1')return reply({detail:'请从评测页面提交'},403);
  const key=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');
  if(key.length<10||key.length>512||/[\r\n]/.test(key))return reply({detail:'请填写有效百炼 API Key'},422);
  let input;
  try {
    const reader=request.body?.getReader(),parts=[];let length=0;
    if(reader)try{while(true){const r=await reader.read();if(r.done)break;length+=r.value.length;if(length>512*1024)return reply({detail:'评分材料超过上限'},413);parts.push(r.value)}}finally{await reader.cancel()}
    const bytes=new Uint8Array(length);let pos=0;for(const p of parts){bytes.set(p,pos);pos+=p.length}input=JSON.parse(new TextDecoder().decode(bytes));
  }catch{return reply({detail:'评分材料格式不完整'},422)}
  const {record,model}=input||{};
  if(!/^qwen[\w.:-]{0,95}$/.test(model||'')||!Array.isArray(record?.turns)||!record.turns.length||record.turns.length>40)return reply({detail:'模型或对话格式不支持'},422);
  if(record.turns.some((t,i)=>!Number.isInteger(t.turn)||t.turn<1||t.turn>40||(i&&t.turn!==record.turns[i-1].turn+1)||['question','answer','reference'].some(k=>typeof t[k]!=='string'||t[k].length>40000)||!t.question.trim()||!t.answer.trim()||t.linked_case&&typeof t.linked_case!=='object'))return reply({detail:'问答字段、轮次或长度无效'},422);
  let material;try{material=reviewMaterial(record)}catch{return reply({detail:'关联期望格式不完整'},422)}
  const messages=[{role:'system',content:answerPolicy.policy+'\n分数锚点：'+JSON.stringify(answerPolicy.anchors)},{role:'user',content:JSON.stringify({records:material,turn_numbers:record.turns.map(t=>t.turn),partial_context:!!record.partial_context})}];
  const digest=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const result={rubric_version:'uploaded-answer-web-v1',model,evidence_sha256:await digest(JSON.stringify(material)),prompt_sha256:await digest(messages[0].content),judge_calls:0,business_calls:0,usage:[],responses:[],execution_verified:false};
  if(JSON.stringify(messages).length>100000)return reply({status:'unjudged',result:{...result,reason:'单轮超出裁判范围，原文未截断',error_stage:'evidence_budget'}});
  for(let attempt=0;attempt<2;attempt++){
    let value;
    try {
      const response=await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({model,messages,temperature:0,enable_thinking:false,max_tokens:16000,response_format:{type:'json_object'}}),redirect:'manual',signal:AbortSignal.timeout(90000)});
      if(!response.ok)return reply({status:'failed',result:{...result,error_stage:'judge_request',reason:'百炼请求失败，请检查 Key、模型权限、额度与网络。'}});
      value=await response.json();result.judge_calls++;result.usage.push({request_id:value.id,usage:value.usage});
    }catch{return reply({status:'failed',result:{...result,error_stage:'judge_request',reason:'裁判请求中断，未计为通过。请检查网络后手动重试。'}})}
    try{const content=value.choices[0].message.content;result.responses.push(content.replaceAll(key,'[redacted]'));const parsed=validateReview(JSON.parse(content),record);return reply({status:'completed',result:{...result,...parsed}})}catch{if(attempt===0)messages.push({role:'user',content:'上次结果未通过逐轮格式或引用校验，请按原轮次重新输出四维整数档位及逐字证据。'})}
  }
  return reply({status:'unjudged',result:{...result,error_stage:'judge_validation',reason:'两次评分均未通过逐轮格式或引用校验，保留待复核。'}});
}
