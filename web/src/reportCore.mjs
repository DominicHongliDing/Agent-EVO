// Pure calculations shared by the browser and the stateless Site report handler.
export const reportMean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
export const reportScoreValue = value => typeof value==='number' && Number.isFinite(value) && value>=0 && value<=5 ? value : null;
export function reportClean(value) {
  if(Array.isArray(value))return value.map(reportClean);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/password|secret|api.?key|authorization|access.?token/i.test(k)).map(([k,v])=>[k,reportClean(v)]));
  return typeof value==='string'?value.replace(/\bsk-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]+/gi,'[凭证已移除]'):value;
}
export function reportCanonical(value) {
  if(Array.isArray(value))return '['+value.map(reportCanonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+reportCanonical(value[k])).join(',')+'}';
  return JSON.stringify(value??null);
}
export function reportAnswerUnit(record) {
  const turns=record.turns,latest=record.assessments?.[0]||{},result=latest.result||{},judged=new Map((result.turns||[]).map(t=>[t.turn,t]));
  const keys=turns.length>1?['factual','coverage','relevance','context']:['factual','coverage','relevance'],scores={},low=[];
  for(const key of keys){const values=[];for(const [i,turn] of turns.entries()){
    if(key==='context'&&i===0)continue;
    const row=(judged.get(turn.turn)?.dimensions||[]).find(d=>d.dimension===key)||{};
    let value=latest.status==='completed'?reportScoreValue(row.score):null;
    if(key==='factual'&&!turn.reference?.trim())value=null;
    values.push(value);if(value!==null&&value<3)low.push({turn:turn.turn,dimension:key,score:value,reason:row.reason||''});
  }scores[key]=values.length&&values.every(v=>v!==null)?reportMean(values):null;}
  const evidence=turns.flatMap(t=>[['user','question'],['assistant','answer'],['reference','reference']].filter(([,f])=>t[f]).map(([role,f])=>({ref:`turn:${t.turn}:${role}`,text:t[f]})));
  for(const t of turns){const expected=t.linked_case?.expected?.behavior;if(typeof expected==='string'&&expected.trim())evidence.push({ref:`turn:${t.turn}:expectation`,text:expected});}
  return {id:record.record_id,question_key:record.record_id,profile:'answers-'+(turns.length>1?'multi':'single'),dimensions:scores,title:turns[0].question,turn_count:turns.length,execution:'uploaded_unverified',assessment_id:latest.assessment_id??null,assessment_status:latest.status||'not_started',assessment_issue:latest.status==='completed'?null:reportClean(latest.result?.reason||null),rubric:result.rubric_version||'answer-review-v3',judge_model:result.model??null,quality:result.quality||'unjudged',critical:(result.critical_findings||[]).map(v=>({kind:'ai_pending',...v})),low_turns:low,evidence,source:record.source||{},linked_cases:turns.map(t=>t.linked_case??null),repeat_eligible:false,retry:false,usage:result.usage||[],trace_coverage:'unverified'};
}
export function reportMetrics(units,repetitions=1) {
  const planned=units.filter(u=>!u.retry),groupBy=(rows,key)=>{const m=new Map();for(const u of rows){const k=key(u);if(!m.has(k))m.set(k,[]);m.get(k).push(u);}return [...m.values()];};
  const profiles=[...new Set(planned.map(u=>u.profile))].sort().map(profile=>{
    const members=planned.filter(u=>u.profile===profile),complete=members.filter(u=>Object.keys(u.dimensions).length&&Object.values(u.dimensions).every(v=>reportScoreValue(v)!==null));
    const partial=reportMean(groupBy(complete,u=>u.question_key).map(g=>reportMean(g.map(u=>reportMean(Object.values(u.dimensions))*20))));
    const dimensions={};for(const key of [...new Set(members.flatMap(u=>Object.keys(u.dimensions)))].sort()){
      const rows=members.filter(u=>reportScoreValue(u.dimensions[key])!==null);
      dimensions[key]={score:reportMean(groupBy(rows,u=>u.question_key).map(g=>reportMean(g.map(u=>u.dimensions[key])))),scored:rows.length,planned:members.length};
    }
    return {profile,score:complete.length===members.length?partial:null,partial_score:partial,scored:complete.length,planned:members.length,dimensions};
  });
  const complete=u=>Object.keys(u.dimensions).length&&Object.values(u.dimensions).every(v=>reportScoreValue(v)!==null);
  const groups=groupBy(planned,u=>u.question_key),judged=groups.map(g=>g.filter(u=>['pass','fail'].includes(u.quality)&&['completed','uploaded_unverified'].includes(u.execution)&&complete(u))).filter(g=>g.length),stable=groups.filter(g=>repetitions>=2&&g.every(u=>u.repeat_eligible));
  return {planned:planned.length,questions:groups.length,turns:planned.reduce((n,u)=>n+u.turn_count,0),scored:profiles.reduce((n,p)=>n+p.scored,0),profiles,assessed:planned.filter(u=>u.assessment_status==='completed').length,critical_unjudged:planned.reduce((n,u)=>n+(u.critical_unjudged||0),0),score:profiles.length===1?profiles[0].score:null,partial_score:profiles.length===1?profiles[0].partial_score:null,pass_rate:reportMean(judged.map(g=>g.filter(u=>u.quality==='pass').length/g.length)),judged:judged.reduce((n,g)=>n+g.length,0),execution_failed:planned.filter(u=>['failed','blocked','timed_out','cancelled'].includes(u.execution)).length,judge_failed:planned.filter(u=>['failed','unjudged','interrupted','cancelled'].includes(u.assessment_status)).length,critical:Object.fromEntries(['rule','ai_pending','human'].map(k=>[k,planned.reduce((n,u)=>n+u.critical.filter(c=>c.kind===k).length,0)])),stability:stable.length&&stable.every(g=>g.length===repetitions&&g.every(complete))?stable.filter(g=>g.length===repetitions&&g.every(u=>u.quality==='pass'&&u.execution==='completed'&&complete(u))).length/stable.length:null,stability_questions:stable.length,repetitions,retries_excluded:units.length-planned.length,business_calls:0};
}
export function reportMaterial(snap) {
  const ordered=[...snap.units].sort((a,b)=>Number(!a.critical.length)-Number(!b.critical.length)||Number(a.quality!=='fail')-Number(b.quality!=='fail')||Number(!a.low_turns.length)-Number(!b.low_turns.length)||(a.id<b.id?-1:a.id>b.id?1:0));
  const records=[];let size=0;
  for(const unit of ordered){const item=Object.fromEntries(['id','profile','dimensions','assessment_status','quality','critical','low_turns','trace_coverage'].map(k=>[k,unit[k]]));item.evidence=unit.evidence.slice(0,10).map(e=>({ref:e.ref,text:e.text.slice(0,900)}));const cost=reportCanonical(item).length;if(size+cost>52000||records.length>=24)break;size+=cost;records.push(item);}
  return {metrics:snap.metrics,records,coverage:{selected:records.length,total:ordered.length},version:snap.version};
}
export function validateReport(value,material) {
  const sections=['summary','strengths','issues','recommendations','limitations'],same=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
  const fail=(reason='字段格式不完整')=>{throw Error('报告格式或证据引用校验未通过：'+reason);};
  if(!value||!same(Object.keys(value),sections))fail('必须恰好包含 summary、strengths、issues、recommendations、limitations 五个数组');
  const refs=new Map(material.records.flatMap(u=>u.evidence.map(e=>[JSON.stringify([u.id,e.ref]),e.text])));
  const citationErrors=[];
  for(const section of sections){const rows=value[section];if(!Array.isArray(rows)||rows.length>8||(['summary','limitations'].includes(section)&&!rows.length))fail(section+' 数组缺失、为空或超过八项');
    for(const [rowIndex,row] of rows.entries()){if(!row||!same(Object.keys(row),['text','metric_refs','evidence']))fail();
      if(typeof row.text!=='string'||row.text.length<2||row.text.length>1600||/\d|临床验证通过|可以上线|可安全上线|根因已确认/.test(row.text))fail(section+' 的 text 长度不符、含阿拉伯数字或禁用断言，请用业务局限描述代替');
      if(!Array.isArray(row.metric_refs)||row.metric_refs.length>12||!Array.isArray(row.evidence)||row.evidence.length>8)fail(section+' 第 '+(rowIndex+1)+' 项引用数组格式不符');
      if(!row.metric_refs.length&&!row.evidence.length)citationErrors.push(section+' 第 '+(rowIndex+1)+' 项缺少依据；范围局限可引用 planned，重复次数局限可引用 repetitions，不允许两个引用数组同时为空');
      const invalidMetrics=row.metric_refs.filter(r=>typeof r!=='string'||!Object.hasOwn(material.metrics,r)||(material.metrics[r]!==null&&typeof material.metrics[r]==='object'));if(invalidMetrics.length)citationErrors.push(section+' 第 '+(rowIndex+1)+' 项指标 '+invalidMetrics.join(',')+' 不是标量键；允许 '+Object.keys(material.metrics).filter(k=>material.metrics[k]===null||typeof material.metrics[k]!=='object').join(','));
      if(['issues','recommendations'].includes(section)&&!row.evidence.length)fail(section+' 必须包含原文引用');
      for(const e of row.evidence){if(!e||!same(Object.keys(e),['record_id','ref','quote']))fail();const text=refs.get(JSON.stringify([e.record_id,e.ref]));if(typeof e.quote!=='string'||e.quote.length<2||e.quote.length>300||!text?.includes(e.quote))citationErrors.push(section+' 引用 '+e.record_id+' / '+e.ref+' 不是有效连续原文：'+String(e.quote).slice(0,90));}
    }
  }if(citationErrors.length)fail(citationErrors.join('；')+'。保留 Markdown、标点与空格，选取较短的连续原文');return value;
}
export function compareReportSnapshots(current,baseline) {
  const group=s=>{const m=new Map();for(const u of s.units.filter(u=>!u.retry)){if(!m.has(u.question_key))m.set(u.question_key,[]);m.get(u.question_key).push(u);}return m;};
  const a=group(current),b=group(baseline),left=[],right=[];
  const scheme=u=>reportCanonical({profile:u.profile,rubric:u.rubric,dimensions:Object.keys(u.dimensions).sort()});
  const complete=g=>g.every(u=>Object.values(u.dimensions).length&&Object.values(u.dimensions).every(v=>reportScoreValue(v)!==null));
  for(const [key,x] of a){const y=b.get(key);if(!y||!complete(x)||!complete(y)||x.some(u=>scheme(u)!==scheme(x[0]))||y.some(u=>scheme(u)!==scheme(x[0])))continue;left.push(...x);right.push(...y);}
  const cm=reportMetrics(left),bm=reportMetrics(right);
  return {current_snapshot:current.snapshot_id,baseline_snapshot:baseline.snapshot_id,current_questions:a.size,baseline_questions:b.size,compared_questions:new Set(left.map(u=>u.question_key)).size,current_score:cm.score,baseline_score:bm.score,delta:cm.score==null||bm.score==null?null:cm.score-bm.score,note:'仅比较输入身份、评分标准一致且完整评分的交集；未关联的导入记录不按相似文字配对。'};
}
