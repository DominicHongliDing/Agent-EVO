// Shared by the visitor UI and its stateless, same-origin judging endpoint.
export const reviewDimensions = ['factual', 'coverage', 'relevance', 'context'];
// Markdown presentation marks may differ in a citation. Repair only a unique,
// contiguous match and replace it with the exact stored source substring.
export function canonicalizeCitations(data,record){
 const refs=new Map(reviewMaterial(record).map(r=>[r.ref,r.text])),repairs=[];
 const normalize=s=>{let text='',positions=[];for(let i=0;i<s.length;i++)if(!/[\s*_`#]/.test(s[i])){text+=s[i];positions.push(i)}return {text,positions}};
 const lists=[...(data.turns||[]).flatMap(t=>Array.isArray(t.dimensions)?t.dimensions.map(d=>d.evidence):[]),...(data.critical_findings||[]).map(f=>f.evidence)];
 for(const items of lists)if(Array.isArray(items))for(const e of items){const source=refs.get(e?.ref);if(!source||typeof e.quote!=='string'||source.includes(e.quote))continue;
 const a=normalize(source),b=normalize(e.quote).text,index=a.text.indexOf(b);if(b.length<4||index<0||a.text.indexOf(b,index+1)!==-1)continue;
 const exact=source.slice(a.positions[index],a.positions[index+b.length-1]+1);if(exact.length>600)continue;
 repairs.push({ref:e.ref,kind:'markdown_whitespace_only'});e.quote=exact;
 }return {data,repairs};
}
export function reviewMaterial(record) {
  return record.turns.flatMap(t => {
    const rows = [['question','user'],['answer','assistant'],['reference','reference']].filter(([k]) => t[k]).map(([k,r]) => ({ref:`turn:${t.turn}:${r}`,text:t[k]}));
    const linked=t.linked_case || {}, expected=Object.fromEntries(Object.entries(linked.expected || {}).filter(([k])=>!['regression_of','source_case_sha256','imported_answer_record','source_file_sha256'].includes(k)));
    if(Object.keys(expected).length || linked.turn_checks?.length) rows.push({ref:`turn:${t.turn}:expectation`,text:JSON.stringify({requirements:expected,turn_checks:linked.turn_checks||[],gold_status:linked.gold_status||'engineering_draft'})});
    return rows;
  });
}
export function reviewSegments(record) {
  const chunks=[]; let current=[];
  for(const t of record.turns) {if(current.length && JSON.stringify(reviewMaterial({turns:[...current,t]})).length>75000){chunks.push(current);current=[];} current.push(t);}
  if(current.length) chunks.push(current); return chunks;
}
export function validateReview(data,record) {
  const refs=new Map(reviewMaterial(record).map(r=>[r.ref,r.text]));
  const citations=items=>{if(!Array.isArray(items)||!items.length||items.length>8)throw Error('缺少原文证据');return items.map(e=>{if(!e||typeof e.quote!=='string'||!e.quote.length||e.quote.length>600||!refs.get(e.ref)?.includes(e.quote))throw Error('引用没有对应原文');return {ref:e.ref,quote:e.quote};});};
  if(!data||typeof data.summary!=='string'||!data.summary.trim()||!Array.isArray(data.turns)||data.turns.length!==record.turns.length)throw Error('逐轮评分不完整');
  const scores=[];
  const turns=data.turns.map((row,i)=>{
    const t=record.turns[i]; if(row.turn!==t.turn||!Array.isArray(row.dimensions)||row.dimensions.length!==4||new Set(row.dimensions.map(d=>d?.dimension)).size!==4)throw Error('轮次或维度不完整');
    return {turn:t.turn,dimensions:row.dimensions.map(d=>{
      let {score,reason}=d;
      if(!reviewDimensions.includes(d.dimension)||typeof reason!=='string'||!reason.trim()||(score!==null&&(!Number.isInteger(score)||score<0||score>5)))throw Error('档位或理由无效');
      if(d.dimension==='factual'&&!t.reference){score=null;reason='缺少参考依据；未判断事实正确性';}
      if(d.dimension==='context'&&t.turn===1){score=null;reason='首轮没有前文，不适用上下文延续检查';}
      else if(d.dimension==='context'&&record.partial_context){score=null;reason='本段缺少此前完整对话，跨段上下文待复核';}
      const evidence=score===null?[]:citations(d.evidence);if(score!==null)scores.push(score);
      return {dimension:d.dimension,score,reason,evidence};
    })};
  });
  if(!Array.isArray(data.critical_findings||[])||(data.critical_findings||[]).length>12)throw Error('风险格式错误');
  const critical_findings=(data.critical_findings||[]).map(f=>{if(typeof f.reason!=='string'||!f.reason.trim())throw Error('风险缺少理由');return {reason:f.reason,evidence:citations(f.evidence)};});
  const applicable=record.turns.reduce((n,t)=>n+2+!!t.reference+(t.turn>1),0);
  return {summary:data.summary,turns,critical_findings,quality:critical_findings.length||scores.some(s=>s<3)?'fail':scores.length===applicable?'pass':'unjudged',root_cause_status:'not_assessed',execution_verified:false,business_calls:0,human_review_required:true};
}
