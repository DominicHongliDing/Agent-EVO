export type ReplayEvent = { seq: number; kind: string; node: string; status: string; created_at: string; payload: unknown }
export type ReplayRun = {
  run_id: string; status: string; execution_mode?: string; agent_name?: string; error_code?: string; output?: Record<string, unknown>
  case?: { agent: 'unihr' | 'clinical' | 'generic'; message: string; case_context_text?: string; materials?: { name: string; text: string }[]; fixtures?: unknown[]; turns?: { message: string }[] }
  events?: ReplayEvent[]
  artifacts?: { artifact_id: string; filename: string; byte_size: number; checks: Record<string, unknown> }[]
  verdicts?: { dimension: string; result: string; rationale: string; critical: number; evaluator?: string }[]
}
type Data = Record<string, unknown>
export type ReplayStep = { key: string; node: string; title: string; description: string; status: string; time: string; seq: number; phase: number }
export type AnswerPart = { title: string; content: string }
export type ReplaySource = { key: string; reference: string; title: string; excerpt: string; version: string }
export const record = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}
export const text = (value: unknown): string => typeof value === 'string' ? value : ''
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []

export function answerParts(run: ReplayRun): AnswerPart[] {
  const result = record(run.output?.result)
  const content = text(record(result.assistant_message).content)
  if (content) return [{ title: '', content }]
  if (typeof result.answer === 'string') return [{ title: '', content: result.answer }]
  const answer = record(result.answer)
  const parts: AnswerPart[] = []
  const summary = text(answer.summary)
  if (summary) parts.push({ title: '', content: summary })
  for (const value of list(answer.sections)) {
    const section = record(value)
    const body = text(section.content)
    if (body && !parts.some(part => part.content === body)) parts.push({ title: text(section.title), content: body })
  }
  return parts
}

export const actionLabels: Record<string, string> = {
  'runner.claim': '安排执行任务', 'runner.start': '开始执行评测', 'runner.inputs': '保存本次输入版本',
  'runner.finish': '保存执行结果', 'clinical.authenticate': '连接 Clinical 服务', 'clinical.submit': '提交本轮问题',
  'clinical.case_context': '准备病例上下文', 'clinical.setup_turn': '准备前序对话',
  'recording.import': '导入已有对话记录', 'recording.evaluation': '评测已有对话',
  'conversation.turn.start': '开始本轮对话', 'conversation.turn.finish': '保存本轮回答',
  'context.semantic.start': '开始检查多轮上下文', 'context.semantic.usage': '记录评审模型用量',
  'context.semantic.response': '收到上下文评审答复', 'context.semantic.result': '保存上下文评审结论',
  diagnosis: '汇总评测结论', final: '收到最终回答', context_entered: '开始理解问题', context: '完成问题理解',
  evidence_entered: '开始查找资料', evidence: '完成资料检查', answer_integrity_entered: '开始检查回答', answer_integrity: '完成回答检查',
  intake: '读取输入材料', clinical_intake: '检查病例信息完整性', knowledge_retrieval: '检索与选择资料',
  model: '生成回答', artifact: '生成与检查产物', run: '交付完整回答', 'visitor.request': '业务请求',
  'script.start': '开始执行评测脚本', 'script.finish': '保存脚本执行结果', 'script.setup': '检查运行环境', 'script.evaluate': '检查回答质量',
  'brief.received': '接收任务', 'brief.compiled': '整理任务要求', 'context.assembled': '整理对话上下文',
  'query.rewritten': '澄清本轮问题', 'task_intent.compiled': '明确任务目标', 'turn.interpreted': '识别用户意图',
  'capability.candidates': '匹配可用能力', 'capability.selected': '选择执行能力',
  'skill.semantic_retrieved': '查找可用技能', 'skill.candidates.reranked': '筛选技能', 'skill.plan.created': '制定技能计划',
  'skill.selected': '选择业务技能', 'skill.plan.validated': '校验执行计划',
  'graph.run.started': '开始执行任务', 'graph.path': '确认执行路径', 'skill.graph.started': '启动业务技能',
  'skill.graph.node.started': '执行业务技能', 'skill.graph.node.completed': '完成业务技能', 'skill.graph.completed': '汇总技能结果',
  'vision.evidence.extracted': '读取材料内容', 'evidence.plan': '制定资料检索计划', 'knowledge.retrieve': '检索本地知识库',
  'evidence.sufficiency': '检查资料是否充分', 'evidence.retry': '补充检索资料', 'policy.effective_date_gate': '核对政策有效期',
  'policy.conflict_gate': '检查政策冲突', 'evidence.sources': '整理引用来源', 'model.answer': '生成回答',
  'claim_evidence.align': '核对结论与证据', 'evidence.graph.completed': '完成证据核对',
  'graph.quality_gate': '检查交付质量', 'graph.run.completed': '完成业务执行',
  'turn.accepted': '接收请求', 'turn.running': '开始处理', 'turn.prepared': '准备会话', 'input.stored': '保存本轮输入',
  'context.prepared': '整理上下文', 'route.selected': '选择执行路线', 'skills.selected': '选择执行技能',
  'run.started': '启动业务执行', 'result.published': '交付回答与文件', 'turn.completed': '完成本轮请求',
  initialize_context: '整理病例信息', load_case_context: '读取病例上下文', plan_current_message: '理解本轮诉求',
  interpret_context_reference: '解析上下文引用', rewrite_clinical_query: '改写检索问题',
  classify_with_router_if_needed: '识别意图与路由', select_prompt_skill: '选择回答策略', assess_case_completeness: '检查信息完整性',
  plan_evidence: '制定资料检索计划', plan_task: '规划工具执行', execute_tools: '检索临床资料', guard_evidence: '检查证据安全',
  observe_tools: '筛选材料与检查充分性', prepare_evidence_retry: '补充检索资料', generate_answer: '生成回答',
  align_claims: '核对结论与证据', review_safety: '检查回答安全', finalize_response: '整理最终答复', runtime_failure: '执行异常',
}
const labels = actionLabels
export const clinicalStreamNode: Record<string, string> = {
  case_parse: 'initialize_context', query_rewrite: 'rewrite_clinical_query', intent_routing: 'classify_with_router_if_needed',
  case_completeness: 'assess_case_completeness', evidence_query_plan: 'plan_evidence', evidence_retrieval: 'execute_tools',
  evidence_security_guard: 'guard_evidence', rerank: 'observe_tools', draft_generation: 'generate_answer',
  claim_evidence_alignment: 'align_claims', safety_review: 'review_safety',
}
const internalNodes = /(^context$|^evidence$|^answer_integrity$|_entered$|\.offloaded$)/
export function eventTitle(event: ReplayEvent) {
  const p = record(event.payload)
  const node = event.node === 'step' ? clinicalStreamNode[text(p.step_id)] || text(p.step_id) : event.node
  return actionLabels[node] || (/\p{Script=Han}/u.test(text(p.title)) ? text(p.title) : '其他已记录动作')
}
export function stepTone(status: string): 'good' | 'warn' | 'bad' | 'live' | 'neutral' {
  if (['failed', 'fail', 'error', 'timed_out', 'blocked', 'cancelled'].includes(status)) return 'bad'
  if (['insufficient', 'review_required', 'revised', 'partial', 'warning', 'degraded'].includes(status)) return 'warn'
  if (['running', 'active', 'started', 'in_progress'].includes(status)) return 'live'
  if (['completed', 'succeeded', 'success', 'pass', 'passed'].includes(status)) return 'good'
  return 'neutral'
}
export function stepStatus(status: string): string {
  return ({ completed: '完成', succeeded: '完成', success: '完成', pass: '通过', passed: '通过',
    failed: '失败', fail: '失败', error: '异常', timed_out: '超时', blocked: '阻塞', cancelled: '取消',
    insufficient: '证据不足', review_required: '待核验', revised: '已修订', partial: '部分完成', warning: '需关注', degraded: '已降级',
    running: '进行中', active: '进行中', started: '进行中', in_progress: '进行中', skipped: '已跳过', queued: '排队中',
    observed: '已记录', unknown: '已记录' } as Record<string, string>)[status] || '已记录'
}
function phaseFor(node: string): number {
  if (/skill\.plan|safety_gate/.test(node)) return 0
  if (/claim|align|review|quality|final|integrity|completed$|validated$/.test(node) && !/skill\.graph\.node|knowledge|retriev/.test(node)) return 3
  if (/evidence|knowledge|policy\.|retriev|rerank|plan_task|execute_tools|observe_tools/.test(node) && !/model\.answer/.test(node)) return 1
  if (/brief|context|query|intent|capability|skill\.(semantic|candidates|plan|selected)|route|skills|input|case_parse|case_completeness|assess_case|select_prompt|turn\.(accepted|running|prepared|interpreted)/.test(node)) return 0
  return 2
}
function clinicalDescription(node: string, data: Data): string {
  if (node === 'prepare_evidence_retry') return `准备补充检索${typeof data.evidence_retry_count === 'number' ? `（已重试 ${data.evidence_retry_count} 次）` : ''}。`
  if (node === 'plan_task') return list(data.selected_tools).includes('clinical_rag_retriever') ? '执行计划包含临床资料检索。' : '业务入口已记录本轮工具执行计划。'
  if (node === 'finalize_response') return '业务入口已整理本轮答复，内容见下方。'
  if (node === 'load_case_context') return '已执行病例上下文读取节点。'
  if (node === 'interpret_context_reference') return '已执行本轮上下文引用解析。'
  if (node === 'plan_current_message') return '已执行本轮请求分析。'
  if (node === 'select_prompt_skill') return '已执行回答策略选择。'
  return '业务入口已记录此步骤的执行结果。'
}
function readableStep(description: string): string {
  return description.replace(/candidate (\d+) 条/g, '候选资料 $1 条').replace(/top (\d+)/g, '前 $1 条')
    .replace(/生成模式：llm/g, '生成模式：大模型').replace(/guideline_management/g, '临床指南与管理建议')
    .replace(/primary only/g, '主流程').replace(/；来源：rule/g, '；依据规则')
    .replace(/clarification_required/g, '需要补充信息').replace(/\brerank\b/g, '重新排序')
    .replace(/安全审核状态：pass/g, '业务安全检查：通过').replace(/安全审核状态：fail/g, '业务安全检查：未通过')
}

// Preserve repeated retrieval attempts. Only replace duplicate transport copies of a business event.
export function replaySteps(run: ReplayRun): ReplayStep[] {
  const events = run.events || []
  if (run.case?.agent === 'clinical') {
    const stream = events.filter(e => e.kind === 'business_event' && record(e.payload).type === 'step')
    const persistent = events.filter(e => e.kind === 'business_step' && !internalNodes.test(e.node))
    const used = new Set<number>()
    const rows = persistent.map(e => {
      const match = stream.find(s => !used.has(s.seq) && (clinicalStreamNode[text(record(s.payload).step_id)] || text(record(s.payload).step_id)) === e.node)
      if (match) used.add(match.seq)
      const p = record(e.payload), s = record(match?.payload)
      const description = readableStep(text(s.detail) || text(p.summary) || text(p.message) || (e.node === 'runtime_failure' ? text(p.output_summary) : clinicalDescription(e.node, record(p.payload))))
      return { key: String(e.seq), node: e.node, title: labels[e.node] || text(s.title) || '业务执行步骤', description,
        status: text(s.status) || e.status, time: text(p.created_at) || match?.created_at || e.created_at, seq: match?.seq || e.seq, phase: phaseFor(e.node) }
    })
    for (const e of stream.filter(s => !used.has(s.seq))) {
      const p = record(e.payload), node = clinicalStreamNode[text(p.step_id)] || text(p.step_id)
      rows.push({ key: String(e.seq), node, title: labels[node] || text(p.title) || '业务执行步骤', description: readableStep(text(p.detail)),
        status: text(p.status) || e.status, time: e.created_at, seq: e.seq, phase: phaseFor(node) })
    }
    // Persistent steps have the business sequence; a stream-only safety gate belongs beside routing.
    if (persistent.length) {
      const extra = rows.find(row => row.node === 'safety_gate')
      if (extra) { rows.splice(rows.indexOf(extra), 1); const routing = rows.findIndex(row => row.node === 'classify_with_router_if_needed'); rows.splice(routing < 0 ? 0 : routing + 1, 0, extra) }
    }
    return rows
  }
  const trace = events.filter(e => e.kind === 'business_trace')
  const canonical = trace.length ? trace : events.filter(e => e.kind === 'business_step')
  const selected = canonical.length ? canonical : events.filter(e => e.kind === 'business_event')
  return selected.filter(e => !internalNodes.test(e.node)).map(e => {
    const p = record(e.payload)
    return { key: String(e.seq), node: e.node, title: labels[e.node] || '业务执行步骤', description: text(p.summary) || '业务入口已记录此步骤。',
      status: text(p.status) || e.status, time: text(p.occurred_at) || text(p.created_at) || e.created_at, seq: e.seq, phase: phaseFor(e.node) }
  })
}

export function replaySources(run: ReplayRun): ReplaySource[] {
  const result = record(run.output?.result)
  const sourceEvent = [...(run.events || [])].reverse().find(e => e.node === 'evidence.sources')
  const payload = record(sourceEvent?.payload)
  const sources = run.case?.agent === 'clinical' ? list(result.citations || result.sources) : list(payload.sources || record(payload.details).sources || result.sources)
  const seen = new Set<string>()
  return sources.flatMap((value, index) => {
    const source = record(value)
    const key = text(source.chunk_id) || `${text(source.source_id)}:${text(source.reference_id) || index}`
    if (seen.has(key)) return []
    seen.add(key)
    return [{ key, reference: text(source.reference_id) || text(source.reference) || `引用 ${index + 1}`, title: text(source.title) || text(source.document_title) || text(source.label) || text(source.name) || '未提供来源标题',
      excerpt: text(source.citation) || text(source.evidence_snippet) || text(source.text), version: [text(source.source_version), text(source.effective_date) && `生效 ${text(source.effective_date)}`].filter(Boolean).join(' · ') }]
  })
}
