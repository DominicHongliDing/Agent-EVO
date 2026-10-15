// Stable, bounded inputs shared by the UI and the independent reviewer. Human review state is deliberately excluded.
export function draftCheckProduct(data){return {description:String(data.description||''),success:String(data.success||''),boundaries:String(data.boundaries||''),references:String(data.references||'')};}
export function draftCheckCase(c){return {case_id:String(c.case_id||''),turns:(c.turns||[]).map(t=>({message:t.message,...(t.branch?{branch:{contains:t.branch.contains,message:t.branch.message}}:{})})),expected:c.expected?.behavior??c.expected??'',reference:String(c.reference||''),category:String(c.category||'')};}
export function draftCheckSignature(product,c){return JSON.stringify({product:draftCheckProduct(product),case:draftCheckCase(c)});}
