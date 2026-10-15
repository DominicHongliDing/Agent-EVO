export function parseDraftMaterial(content) {
 let parsed;
 try { parsed=JSON.parse(content); }
 catch { parsed=content.split(/\r?\n/).map((line,i)=>({line,i})).filter(x=>x.line.trim()).map(({line,i})=>{try{return JSON.parse(line)}catch{throw Error(`第 ${i+1} 行不是有效 JSON；请检查引号与逗号，或下载 Excel 模板填写。`)}}); }
 const list=Array.isArray(parsed)?parsed:parsed?.cases;
 if(!Array.isArray(list)||!list.length)throw Error('没有读到问题；请上传问题数组，或使用 Excel / CSV 问题模板。');
 if(list.length>100)throw Error(`共有 ${list.length} 道题，单个测试集最多 100 道，请拆分上传。`);
 const ids=new Set();
 return list.map((c,i)=>{
  if(!c||typeof c!=='object')throw Error(`第 ${i+1} 条需要包含用户问题。`);
  const turns=c.turns??[{message:c.message??c.question}];
  if(!Array.isArray(turns)||!turns.length||turns.length>20)throw Error(`第 ${i+1} 条的 turns 需要 1–20 轮。`);
  turns.forEach((t,j)=>{if(!t||typeof t.message!=='string'||!t.message.trim())throw Error(`第 ${i+1} 条、第 ${j+1} 轮：用户问题不能为空。`)});
  const id=String(c.case_id||`import_${i+1}`);if(ids.has(id))throw Error(`第 ${i+1} 条的用例 ID「${id}」重复；多轮问题请放入同一条的 turns。`);ids.add(id);
  return {...c,case_id:id,turns:turns.map(t=>({...t})),review_status:'draft'};
 });
}
export function draftCoverage(cases) {
 const labels={core:'核心任务',boundary:'信息不足 / 边界',context:'多轮上下文',refusal:'能力边界',focus:'重点场景'};
 const counts=Object.fromEntries(Object.keys(labels).map(k=>[k,0]));let other=0;
 for(const c of cases){if(c.category in counts)counts[c.category]++;else other++;}
 return {groups:Object.entries(labels).map(([id,label])=>({id,label,count:counts[id]})),other,total:cases.length,multi:cases.filter(c=>c.turns.length>1).length,confirmed:cases.filter(c=>c.review_status==='confirmed').length};
}
