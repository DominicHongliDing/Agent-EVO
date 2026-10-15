import {coverageGaps,allocateCoverage} from './coveragePlan.mjs';
// Each accepted group has already been persisted by /generate before this callback.
export async function generateBatch({initial=[],count,plan,request,onBatch,stopped=()=>false}) {
 if(!Number.isInteger(count)||count<1||initial.length+count>100)throw Error('每个测试集最多 100 条');
 if(plan&&initial.length+coverageGaps(plan,initial).missing>100)throw Error('已有题目加场景缺口超过 100 条，请删减多余草稿或调整配额');
 let rows=[...initial],requests=0;const target=rows.length+count,limit=Math.ceil(count/5)+1;
 while(rows.length<target&&requests<limit&&!stopped()){
  const missing=plan?coverageGaps(plan,rows):null;if(missing&&!missing.missing)break;
  const size=Math.min(10,target-rows.length,missing?.missing??100);
  const result=await request({count:size,...(missing?{coverage:allocateCoverage(size,missing.deficits)}:{}),exclude:rows.map(c=>c.turns.map(t=>t.message).join('\n'))});requests++;
  rows=[...rows,...result.cases];onBatch({rows,result,target,requests});
  if(!result.cases.length)throw Error('本组没有有效新题，已停止继续请求；已有草稿保留，请调整描述再继续。');
 }
 return {rows,target,requests,status:rows.length>=target?'completed':stopped()?'stopped':'partial'};
}
