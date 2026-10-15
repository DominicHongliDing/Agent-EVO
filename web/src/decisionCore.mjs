// Product-facing conclusions are derived from saved evidence, never fabricated by the report model.
export const decisionDimensions = {
  factual: ['回答与参考依据不一致', '用户可能据此作出错误判断', '核对参考资料与回答差异，再用原问题验证'],
  evidence_consistency: ['回答没有充分遵循给定材料', '用户难以依赖回答中的事实', '核对引用与检索结果，再检查回答是否正确采用材料'],
  context: ['对话信息没有被持续遵循', '用户已经说明或更正的信息可能失效', '按原顺序重放对话，检查每轮是否沿用最新事实'],
  coverage: ['用户的要求没有完整完成', '用户需要补问或手动完成遗漏部分', '逐项列出应完成的要求，用同题检查是否全部覆盖'],
  relevance: ['回答偏离了用户需求', '用户需要花额外时间筛选有用信息', '确认任务边界，检查是否直接回应用户的问题'],
  clarity: ['回答不够清楚', '用户可能难以理解或采取下一步行动', '检查答案结构与行动说明，保留原题进行复核'],
};
export function decisionFindings(snapshot) {
  return snapshot.units.flatMap(u => {
    const critical=(u.critical||[]).map((c,i)=>({key:`${u.id}:critical:${i}`,record_id:u.id,title:'关键风险需要单独复核',reason:c.reason||c.rationale||'请查看原始风险证据',impact:'可能影响任务安全或核心业务要求，需优先核实',action:'先核对原文与业务要求，确认风险后再制定修复和回归计划',priority:0,kind:c.kind||'ai_pending',turn:null,evidence:u.evidence||[]}));
    const low=(u.low_turns||[]).map((v,i)=>{const d=decisionDimensions[v.dimension]||['回答存在待复核的问题','可能影响本次任务完成','对照要求检查原回答，再选择原题重测'];return {key:`${u.id}:${v.dimension}:${v.turn||0}:${i}`,record_id:u.id,title:d[0],reason:v.reason,impact:d[1],action:d[2],priority:1,kind:'quality',turn:v.turn||null,evidence:u.evidence||[]};});
    if(!critical.length&&!low.length&&u.quality==='fail')low.push({key:`${u.id}:quality`,record_id:u.id,title:'这条回答需要复核',reason:'已有判决发现问题，请打开记录核对判决理由。',impact:'本次任务可能未按要求完成',action:'确认失败要求与原文，补齐证据后再确定修复方向',priority:1,kind:'quality',turn:null,evidence:u.evidence||[]});
    return [...critical,...low].map(f=>({...f,question:u.title}));
  }).sort((a,b)=>a.priority-b.priority||a.record_id.localeCompare(b.record_id));
}
export function decisionSummary(snapshot) {
  const units=snapshot.units.filter(u=>!u.retry),findings=decisionFindings({...snapshot,units}),counts={pass:0,fail:0,unknown:0};
  for(const u of units){const complete=Object.values(u.dimensions||{}).length>0&&Object.values(u.dimensions).every(v=>typeof v==='number'&&Number.isFinite(v));const executable=['completed','uploaded_unverified'].includes(u.execution);if(!complete||!executable||!['pass','fail'].includes(u.quality))counts.unknown++;else counts[u.quality]++;}
  const ready=units.length>0&&!findings.length&&!counts.unknown&&!snapshot.exploratory&&units.every(u=>u.review_status==='confirmed');
  const status=findings.length?'review':ready?'continue':'insufficient';
  return {status,title:findings.length?'先核实这些问题，再判断改进方向':ready?'本次范围内可继续验证':'先确认材料和评分覆盖',description:findings.length?`发现 ${new Set(findings.map(f=>f.record_id)).size} 条涉及问题的记录；优先查看关键风险和用户任务未完成的情况。`:ready?`这 ${units.length} 份记录已完成评分且达到已确认要求。下一步扩大留出题与重复次数，确认表现能否保持；本结论不自动批准上线。`:'当前没有可列出的失败证据。这不等于 Agent 已经通过全部业务要求。',counts,findings,total:units.length};
}
