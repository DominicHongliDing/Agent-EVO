import type { ReplayRun, ReplayEvent } from './replayPresentation'

type Data = Record<string, unknown>
export type TimelineStep = ReturnType<typeof rowFor>
const labels: Record<string, string> = {
  "runner.claim": "安排执行任务",
  "runner.start": "开始执行评测",
  "runner.inputs": "保存本次输入版本",
  "runner.finish": "保存执行结果",
  "clinical.authenticate": "连接 Clinical 服务",
  "clinical.submit": "提交本轮问题",
  "clinical.case_context": "准备病例上下文",
  "clinical.setup_turn": "准备前序对话",
  "recording.import": "导入已有对话记录",
  "recording.evaluation": "评测已有对话",
  "conversation.turn.start": "开始本轮对话",
  "conversation.turn.finish": "保存本轮回答",
  "context.semantic.start": "开始检查多轮上下文",
  "context.semantic.usage": "记录评审模型用量",
  "context.semantic.response": "收到上下文评审答复",
  "context.semantic.result": "保存上下文评审结论",
  "diagnosis": "汇总评测结论",
  "final": "收到最终回答",
  "context_entered": "开始理解问题",
  "context": "完成问题理解",
  "evidence_entered": "开始查找资料",
  "evidence": "完成资料检查",
  "answer_integrity_entered": "开始检查回答",
  "answer_integrity": "完成回答检查",
  "intake": "读取输入材料",
  "clinical_intake": "检查病例信息完整性",
  "knowledge_retrieval": "检索与选择资料",
  "model": "生成回答",
  "artifact": "生成与检查产物",
  "run": "交付完整回答",
  "visitor.request": "业务请求",
  "script.start": "开始执行评测脚本",
  "script.finish": "保存脚本执行结果",
  "script.setup": "检查运行环境",
  "script.evaluate": "检查回答质量",
  "brief.received": "接收任务",
  "brief.compiled": "整理任务要求",
  "context.assembled": "整理对话上下文",
  "query.rewritten": "澄清本轮问题",
  "task_intent.compiled": "明确任务目标",
  "turn.interpreted": "识别用户意图",
  "capability.candidates": "匹配可用能力",
  "capability.selected": "选择执行能力",
  "skill.semantic_retrieved": "查找可用技能",
  "skill.candidates.reranked": "筛选技能",
  "skill.plan.created": "制定技能计划",
  "skill.selected": "选择业务技能",
  "skill.plan.validated": "校验执行计划",
  "graph.run.started": "开始执行任务",
  "graph.path": "确认执行路径",
  "skill.graph.started": "启动业务技能",
  "skill.graph.node.started": "执行业务技能",
  "skill.graph.node.completed": "完成业务技能",
  "skill.graph.completed": "汇总技能结果",
  "vision.evidence.extracted": "读取材料内容",
  "evidence.plan": "制定资料检索计划",
  "knowledge.retrieve": "检索本地知识库",
  "evidence.sufficiency": "检查资料是否充分",
  "evidence.retry": "补充检索资料",
  "policy.effective_date_gate": "核对政策有效期",
  "policy.conflict_gate": "检查政策冲突",
  "evidence.sources": "整理引用来源",
  "model.answer": "生成回答",
  "claim_evidence.align": "核对结论与证据",
  "evidence.graph.completed": "完成证据核对",
  "graph.quality_gate": "检查交付质量",
  "graph.run.completed": "完成业务执行",
  "turn.accepted": "接收请求",
  "turn.running": "开始处理",
  "turn.prepared": "准备会话",
  "input.stored": "保存本轮输入",
  "context.prepared": "整理上下文",
  "route.selected": "选择执行路线",
  "skills.selected": "选择执行技能",
  "run.started": "启动业务执行",
  "result.published": "交付回答与文件",
  "turn.completed": "完成本轮请求",
  "initialize_context": "整理患者信息",
  "load_case_context": "读取病例上下文",
  "plan_current_message": "理解本轮诉求",
  "interpret_context_reference": "确认问题提到了哪些已有信息",
  "rewrite_clinical_query": "整理本轮问题",
  "classify_with_router_if_needed": "识别咨询意图",
  "select_prompt_skill": "选择回答方式",
  "assess_case_completeness": "检查信息完整性",
  "plan_evidence": "制定资料检索计划",
  "plan_task": "安排检索工具",
  "execute_tools": "检索临床资料",
  "guard_evidence": "检查检索资料的安全性",
  "observe_tools": "筛选资料并判断是否足够",
  "prepare_evidence_retry": "补充检索资料",
  "generate_answer": "生成回答",
  "align_claims": "核对回答是否有证据支持",
  "review_safety": "检查回答风险",
  "finalize_response": "整理最终答复",
  "runtime_failure": "执行异常",
  "safety_gate": "确认处理方式"
};


const obj = (v: unknown): Data => v && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const aliases: Record<string, string> = {case_parse:'initialize_context',query_rewrite:'rewrite_clinical_query',intent_routing:'classify_with_router_if_needed',case_completeness:'assess_case_completeness',evidence_query_plan:'plan_evidence',evidence_retrieval:'execute_tools',evidence_security_guard:'guard_evidence',rerank:'observe_tools',draft_generation:'generate_answer',claim_evidence_alignment:'align_claims',safety_review:'review_safety'};
const internal = /^(context|evidence|answer_integrity)(_entered)?$|\.offloaded$/;
const nodeOf = (e: ReplayEvent): string => e.node === 'step' ? aliases[str(obj(e.payload).step_id)] || str(obj(e.payload).step_id) || 'step' : e.node;
const dataOf = (e?: ReplayEvent | null): Data => {const p=obj(e?.payload);return {...p,...obj(p.payload),...obj(p.details),...obj(p.metadata)};};
const startStates = ['started','running','active','in_progress'];
const failStates = ['failed','fail','error','timed_out','blocked','cancelled'];
const values: Record<string, string> = {guideline_management:'临床指南与管理建议',clinical_rag_retriever:'临床资料检索',clarification:'补充信息',diagnosis:'诊断分析',differential_diagnosis:'鉴别诊断',medication:'用药咨询',medication_guidance:'用药咨询',risk_assessment:'风险评估',follow_up:'随访建议',general_qa:'一般咨询',llm:'大模型生成',rule:'规则判断',rule_based:'规则判断',model:'模型判断',shadow:'仅检查，不阻断回答',primary:'主要任务',retry:'继续补充检索',generate:'生成回答',not_required:'无需执行',no_context_available:'没有可用的历史上下文',national_clinical_guidelines:'国家临床指南',international_intervention_guides:'国际干预指南',clinical_pathways:'临床路径',severity:'症状严重程度',risk_signals:'自伤、自杀、伤人或其他安全风险',current_treatment:'当前治疗情况',presenting_problem:'主要症状',pass:'通过',fail:'未通过',revised:'已修订',completed:'已完成',skipped:'已跳过',insufficient:'不足',sufficient:'足够',allowed:'可使用',blocked:'已阻止',policy_fallback:'按预设规则安排'};
const fields: Record<string, string> = {
 raw_message:'用户原话',message:'本轮问题',query:'检索问题',rewritten_message:'整理后的问题',rewritten_query:'整理后的问题',rewritten_queries:'检索的问题',
 intent:'识别出的咨询意图',current_intent:'本轮意图',task_intent:'任务目标',route:'处理路线',selected_tools:'使用的工具',prompt_skill_id:'回答方式',secondary_intents:'同时涉及的问题',
 context_used:'是否使用已有上下文',case_context_used:'是否使用患者信息',case_context_loaded:'是否读取患者信息',case_context_chars:'患者信息字数',memory_used:'是否使用对话记忆',query_rewrite_trigger:'整理问题的原因',
 missing_case_fields:'待补充的患者信息',case_complete:'患者信息是否完整',intake_gate_mode:'缺少信息时的处理方式',needs_retrieval:'是否需要查找资料',
 retrieval_query_count:'检索问题数',candidate_count:'找到的候选资料数',retrieval_candidate_count:'找到的候选资料数',citation_count:'引用条数',evidence_count:'资料条数',selected_sources:'选用的资料来源',tool_execution_count:'工具调用次数',
 evidence_scanned_count:'已检查的资料数',quarantined_evidence_count:'已隔离的资料数',evidence_security_status:'资料安全检查结果',evidence_sufficient:'资料是否足够',missing_evidence_types:'仍需补充的资料类型',rerank_top_k:'保留的资料条数',evidence_retry_count:'补充检索次数',agent_decision:'下一步安排',agent_action:'下一步安排',
 generation_mode:'回答生成方式',clinical_claim_count:'已检查的结论数',directly_supported_claim_count:'有直接依据的结论数',partially_supported_claim_count:'有部分依据的结论数',unsupported_claim_count:'缺少依据的结论数',conflicting_claim_count:'依据存在冲突的结论数',claim_evidence_status:'结论核对结果',
 safety_review_status:'回答安全检查结果',safety_flags:'发现的风险',required_revisions:'需要修改的内容',safety_revision_count:'安全修订次数',
 error:'异常说明',error_message:'异常说明',error_code:'异常编号',evidence_plan_error:'检索规划异常',query_rewrite_error:'问题整理异常',summary:'记录摘要',detail:'步骤说明',answer:'回答',content:'内容',filename:'文件名称'
};
const commonInput = ['raw_message','message','query'];
const groups: Record<string, string[]> = {
 initialize_context:['case_context_loaded','case_context_chars'],load_case_context:['case_context_loaded','case_context_used','case_context_chars'],
 interpret_context_reference:['context_used','case_context_used','memory_used'],rewrite_clinical_query:['rewritten_message','rewritten_query','context_used','query_rewrite_trigger','query_rewrite_error'],
 classify_with_router_if_needed:['intent','needs_retrieval','case_context_used','memory_used'],select_prompt_skill:['prompt_skill_id','selected_tools'],safety_gate:['prompt_skill_id','selected_tools','secondary_intents'],
 assess_case_completeness:['case_complete','missing_case_fields','intake_gate_mode'],plan_evidence:['rewritten_queries','evidence_plan_error'],plan_task:['selected_tools','needs_retrieval'],
 execute_tools:['selected_tools','retrieval_query_count','candidate_count','retrieval_candidate_count','evidence_count','citation_count','selected_sources','tool_execution_count'],
 guard_evidence:['evidence_scanned_count','evidence_security_status','quarantined_evidence_count'],observe_tools:['evidence_sufficient','rerank_top_k','missing_evidence_types','agent_decision','agent_action'],prepare_evidence_retry:['evidence_retry_count','missing_evidence_types'],
 generate_answer:['generation_mode'],align_claims:['clinical_claim_count','claim_evidence_status','directly_supported_claim_count','partially_supported_claim_count','unsupported_claim_count','conflicting_claim_count'],
 review_safety:['safety_review_status','safety_flags','required_revisions','safety_revision_count'],finalize_response:['safety_review_status','claim_evidence_status']
};
const statusLabels: Record<string, string> ={completed:'已完成',succeeded:'已完成',success:'已完成',passed:'已通过',pass:'已通过',failed:'失败',fail:'未通过',error:'异常',timed_out:'超时',blocked:'已阻止',cancelled:'已取消',skipped:'已跳过',queued:'等待执行',observed:'已记录',unknown:'已记录',insufficient:'信息不足',review_required:'待复核',partial:'部分完成',warning:'需关注',degraded:'已降级',revised:'已修订'};
export function statusOf(status: string,run: ReplayRun) {
 if(startStates.includes(status)) return {label:['running','queued','in_progress'].includes(run.status)?'开始处理':'当时开始',tone:'neutral'};
 return {label:statusLabels[status]||'已记录',tone:failStates.includes(status)?'bad':['insufficient','review_required','partial','warning','degraded'].includes(status)?'warn':['completed','succeeded','success','pass','passed'].includes(status)?'good':'neutral'};
}
Object.assign(values,{follow_up_questions:'补充询问患者情况',not_applicable:'本轮不适用','china-nhc-mental-disorders-2020':'国家卫健委《精神障碍诊疗规范》（2020 年版）','who-mhgap-guideline-2023':'WHO mhGAP 指南（2023 年版）'});
function readable(text: unknown) {
 return str(text).replace(/candidate (\d+) 条/g,'候选资料 $1 条').replace(/top (\d+)/g,'前 $1 条').replace(/主张/g,'结论').replace(/primary only/g,'主要任务').replace(/RAG/g,'资料检索').replace(/rerank/gi,'资料筛选').replace(/影子模式/g,'仅检查模式').replace(/agent 执行状态/gi,'处理步骤').replace(/安全\/任务路由完成/g,'已确认处理方式').replace(/；来源：rule/g,'；依据规则').replace(/已接收病例问题，并准备可观测的处理步骤。/g,'已收到病例与问题，开始整理患者信息。').replace(/\b(guideline_management|clarification_required|llm|pass|fail|skipped|completed)\b/g,k=>values[k]||({clarification_required:'需要补充信息'} as Record<string,string>)[k]);
}
function parsed(v: unknown): Data {if(typeof v==='string'){try{return obj(JSON.parse(v))}catch{return {}}}return obj(v)}
function specificSummary(node: string,d: Data,status: string,p: Data) {
 if(status==='completed') {
  if(node==='initialize_context' && p.detail)return '已收到病例与问题，开始整理患者信息。';
  if(node==='classify_with_router_if_needed' && d.intent)return `识别为“${values[str(d.intent)]||d.intent}”${d.needs_retrieval===true?'，需要查找相关资料。':'。'}`;
  if(node==='safety_gate' && Array.isArray(d.selected_tools))return `已确认处理方式，选用 ${d.selected_tools.length} 个工具。`;
  if(node==='assess_case_completeness' && Array.isArray(d.missing_case_fields))return d.missing_case_fields.length?`发现 ${d.missing_case_fields.length} 项患者信息待补充${d.intake_gate_mode==='shadow'?'；本次仅检查，未阻断回答':'。'}`:'患者信息完整性检查：没有发现缺项。';
  if(node==='plan_evidence' && Array.isArray(d.rewritten_queries))return `整理出 ${d.rewritten_queries.length} 个检索问题。`;
  if(node==='execute_tools' && typeof d.candidate_count==='number')return `找到 ${d.candidate_count} 条候选资料${typeof d.citation_count==='number'?`，记录了 ${d.citation_count} 条引用`:''}。`;
  if(node==='guard_evidence' && typeof d.evidence_scanned_count==='number')return `检查了 ${d.evidence_scanned_count} 条检索资料${typeof d.quarantined_evidence_count==='number'?`，隔离 ${d.quarantined_evidence_count} 条`:''}。`;
  if(node==='observe_tools' && typeof d.evidence_sufficient==='boolean')return `${typeof d.rerank_top_k==='number'?`保留前 ${d.rerank_top_k} 条资料；`:''}${d.evidence_sufficient?'当前资料充分性检查通过。':`仍有资料缺口${Array.isArray(d.missing_evidence_types)?`（${d.missing_evidence_types.length} 类）`:''}${d.agent_decision==='retry'?'，继续补充检索。':'。'}`}`;
  if(node==='generate_answer' && d.generation_mode==='llm')return '已用大模型生成回答草稿。';
  if(node==='review_safety' && d.safety_review_status)return `回答安全检查：${values[str(d.safety_review_status)]||d.safety_review_status}。`;
 }
 if(node==='rewrite_clinical_query' && status==='skipped' && d.query_rewrite_trigger==='no_context_available')return '本轮没有可用的历史上下文，跳过问题改写。';
 if (/\p{Script=Han}/u.test(str(p.detail)) && !/\b\w+=/.test(str(p.detail))) return readable(p.detail);
 if (/\p{Script=Han}/u.test(str(p.summary)) && !/\b\w+=/.test(str(p.summary))) return readable(p.summary);
 const done=['completed','success','succeeded','pass','passed'].includes(status);
 if(failStates.includes(status))return '此步骤未正常完成，点开查看已保存的异常说明。';
 if(status==='skipped')return '本轮跳过此步骤，原因可在详情中查看。';
 if(!done)return startStates.includes(status)?'记录了此步骤开始时的状态。':'此动作已有记录，点开查看保存的内容。';
 if(node==='classify_with_router_if_needed' && d.intent)return `本轮咨询属于“${values[str(d.intent)]||d.intent}”${d.needs_retrieval===true?'，需要查找相关资料。':'。'}`;
 if(node==='execute_tools' && typeof d.evidence_count==='number')return `本次记录了 ${d.evidence_count} 条资料。`;
 if(node==='observe_tools' && typeof d.evidence_sufficient==='boolean')return d.evidence_sufficient?'资料充分性检查：当前资料足够。':'当前资料仍有缺口，需要补充检索或缩小回答范围。';
 if(node==='prepare_evidence_retry')return `准备补充检索${typeof d.evidence_retry_count==='number'?`，已补充 ${d.evidence_retry_count} 次`:''}。`;
 if(node==='review_safety' && d.safety_review_status)return `回答安全检查：${values[str(d.safety_review_status)]||d.safety_review_status}。`;
 return ({initialize_context:'已完成患者信息整理。',load_case_context:'已完成已有患者信息的读取步骤。',plan_current_message:'已完成本轮问题分析。',interpret_context_reference:'已检查本轮问题与已有信息的关系。',rewrite_clinical_query:'已完成本轮问题的整理步骤。',select_prompt_skill:'已完成回答方式的选择。',plan_task:'已完成工具执行计划。',generate_answer:'已完成回答生成步骤。',finalize_response:'已整理本轮最终答复。','runner.claim':'任务已交给执行程序。','runner.start':'评测任务在此时启动。','runner.inputs':'已保存本次评测输入的版本信息。','runner.finish':'已保存本次执行结果。','clinical.authenticate':'已完成 Clinical 服务连接。','clinical.submit':'已提交本轮咨询问题。',diagnosis:'已汇总本次评测发现。'} as Record<string,string>)[node] || '已完成此步骤，点开查看已保存的信息。';
}
export function rowFor(source: ReplayEvent,paired: ReplayEvent | null,run: ReplayRun) {
 const p=obj(source.payload), sp=obj(paired?.payload), node=nodeOf(source);
 const d={...dataOf(source),...dataOf(paired)};
 const status=str(sp.status)||str(p.status)||source.status;
 const sourceTime=str(p.created_at)||str(p.occurred_at)||source.created_at;
 const duration=typeof p.latency_ms==='number'&&Number.isFinite(p.latency_ms)&&p.latency_ms>=0?p.latency_ms:null;
 return {key:String(source.seq),node,title:labels[node]||str(sp.title)||(/\p{Script=Han}/u.test(str(p.title))?str(p.title):'其他已记录步骤'),description:specificSummary(node,d,status,{...p,...sp}),status:statusOf(status,run),time:sourceTime,duration,data:d,input:parsed(p.input_summary),sources:paired?[source,paired]:[source]};
}
export function stepsFor(events: ReplayEvent[],run: ReplayRun) {
 const streams=events.filter(e=>e.kind==='business_event'&&obj(e.payload).type==='step');
 const persistent=events.filter(e=>e.kind==='business_step'&&!internal.test(e.node));
 const traces=events.filter(e=>e.kind==='business_trace'&&!internal.test(e.node));
 const canonical=run.case?.agent!=='clinical' && traces.length ? traces : persistent.length ? persistent : traces;
 const used=new Set();
 const rows=canonical.map(e=>{
  const pair=streams.find(s=>!used.has(s.seq)&&nodeOf(s)===nodeOf(e));
  if(pair)used.add(pair.seq);
  return rowFor(e,pair || null,run);
 });
 streams.filter(e=>!used.has(e.seq)).forEach(e=>rows.push(rowFor(e,null,run)));
 if(!canonical.length && !streams.length) events.filter(e=>e.kind==='business_event'&&!internal.test(e.node)).forEach(e=>rows.push(rowFor(e,null,run)));
 // Recorded business times take precedence over later collection times. Keep
 // occurrence order for repeated retrievals and never merge across turns.
 return rows.sort((a,b)=>{const x=Date.parse(a.time),y=Date.parse(b.time);return Number.isFinite(x)&&Number.isFinite(y)?x-y:0;});
}
export function buildTimeline(run: ReplayRun) {
 const events=run.events || [], turns=run.case?.turns || [];
 const sections=(turns.length?turns:[{message:run.case?.message||''}]).map((turn,index)=>({message:turn.message||'',number:index+1,steps:stepsFor(turns.length>1?events.filter(e=>obj(e.payload).turn_index===index+1):events,run)}));
 return {sections,events,unassigned:turns.length>1?events.filter(e=>obj(e.payload).turn_index==null&&['business_step','business_trace','business_event'].includes(e.kind)).length:0};
}
export const durationText = (ms: number | null) => ms===null?'':ms<1000?`${ms} 毫秒`:`${(ms/1000).toFixed(ms<10000?2:1)} 秒`;
function valueText(v: unknown): string {if(v===true)return '是';if(v===false)return '否';if(typeof v==='number')return String(v);if(typeof v==='string')return values[v]||readable(v);if(Array.isArray(v)&&v.every(x=>['string','number'].includes(typeof x)))return v.length?v.map(valueText).join('、'):'无';return '';}
export function visibleFacts(data: Data,keys: string[]): [string, string][] {return [...new Set(keys)].flatMap(k=>{const v=data[k];return fields[k]&&v!==null&&v!==undefined&&valueText(v)!==''?[[fields[k],valueText(v)] as [string,string]]:[];});}

export function stepFacts(row: TimelineStep) {
 const input = visibleFacts({...row.input, ...Object.fromEntries(commonInput.filter(k => row.data[k] !== undefined).map(k => [k, row.data[k]]))}, [...Object.keys(row.input), ...commonInput])
 const output = visibleFacts(row.data, groups[row.node] || Object.keys(fields).filter(k => !commonInput.includes(k) && !['summary', 'detail'].includes(k)))
 const errors = visibleFacts(row.data, ['error', 'error_message', 'error_code', 'evidence_plan_error', 'query_rewrite_error'])
 return {input, output, errors}
}
