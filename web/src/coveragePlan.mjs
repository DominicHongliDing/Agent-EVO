export const coverageLabels={core:'核心任务',boundary:'信息不足 / 边界',context:'多轮上下文',refusal:'拒绝 / 能力边界',focus:'用户重点场景'};
export const coverageKeys=Object.keys(coverageLabels);
export function validatePlan(plan,max=100){
 if(!plan||typeof plan!=='object'||coverageKeys.some(k=>!Number.isInteger(plan[k])||plan[k]<0)||Object.keys(plan).some(k=>!coverageKeys.includes(k)))throw Error('每个场景需要填写非负整数题量');
 const total=coverageKeys.reduce((n,k)=>n+plan[k],0);if(total<1||total>max)throw Error(`场景总题量需要在 1–${max} 之间`);return total;
}
export function allocateCoverage(count,weights){
 const total=coverageKeys.reduce((n,k)=>n+weights[k],0);if(!Number.isInteger(count)||count<1||count>total)throw Error('需要补充的题量无效');
 const plan=Object.fromEntries(coverageKeys.map(k=>[k,Math.floor(count*weights[k]/total)]));
 const order=[...coverageKeys].sort((a,b)=>(count*weights[b]/total-plan[b])-(count*weights[a]/total-plan[a]));
 for(let i=0,left=count-Object.values(plan).reduce((a,b)=>a+b,0);i<left;i++)plan[order[i]]++;
 return plan;
}
export function defaultCoverage(count){return count===5?Object.fromEntries(coverageKeys.map(k=>[k,1])):allocateCoverage(count,{core:40,boundary:20,context:20,refusal:10,focus:10});}
export function coverageGaps(plan,cases){
 validatePlan(plan);const counts=Object.fromEntries(coverageKeys.map(k=>[k,0]));let other=0;
 for(const c of cases){if(c.review_status==='disabled')continue;if(coverageKeys.includes(c.category)&&(c.category!=='context'||c.turns?.length>=2))counts[c.category]++;else other++;}
 const deficits=Object.fromEntries(coverageKeys.map(k=>[k,Math.max(0,plan[k]-counts[k])]));
 return {counts,deficits,other,missing:Object.values(deficits).reduce((a,b)=>a+b,0)};
}
