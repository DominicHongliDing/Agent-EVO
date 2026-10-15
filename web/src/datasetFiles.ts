import { parseAnswerFile } from './browserAnswerFiles'
export async function datasetFile(file:File){
  if(file.size>5_242_880)throw Error('文件超过 5 MiB')
  const text=/\.xlsx$/i.test(file.name)?'':await file.text()
  if(!/\.(xlsx|csv)$/i.test(file.name))return {filename:file.name,content:text}
  const parsed=await parseAnswerFile(file)
  if(parsed.errors.length)throw Error(parsed.errors.map((r:any)=>`第 ${r.line} 行：${r.message}`).join('；'))
  const groups=new Map<string,any[]>()
  for(const row of parsed.rows){const v=row.value,id=String(v['用例 ID']||v.case_id||`row_${row.line}`),question=v['用户问题']??v.message??v.question;if(typeof question!=='string'||!question.trim())throw Error(`第 ${row.line} 行：用户问题不能为空`);const turn=Number(v['轮次']||v.turn||1);if(!Number.isInteger(turn)||turn<1)throw Error(`第 ${row.line} 行：轮次须为正整数`);const item={line:row.line,turn,question,expectation:String(v['希望做到什么']||v.expectation||v.expected||''),reference:String(v['参考依据']||v.reference||''),category:String(v['场景']||v.category||'general')};groups.set(id,[...(groups.get(id)||[]),item])}
  const cases=[...groups].map(([id,rows])=>{rows.sort((a,b)=>a.turn-b.turn);if(rows.some((r,i)=>r.turn!==i+1))throw Error(`用例 ${id} 的轮次须从 1 连续递增，不能重复`);return {case_id:id,title:rows[0].question.slice(0,100),message:rows[0].question,category:rows[0].category,synthetic:false,gold_status:'engineering_draft',reference:[...new Set(rows.map(r=>r.reference).filter(Boolean))].join('\n'),expected:{behavior:rows.map(r=>`第 ${r.turn} 轮：${r.expectation||'待补充要求'}`).join('\n'),requirements:rows.map(r=>({turn:r.turn,behavior:r.expectation,reference:r.reference})),review_status:'draft'},...(rows.length>1?{turns:rows.map(r=>({message:r.question}))}:{})}})
  return {filename:file.name.replace(/\.(xlsx|csv)$/i,'.json'),content:JSON.stringify(cases)}
}
