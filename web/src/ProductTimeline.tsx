import { ChevronDown, MessageSquare } from 'lucide-react'
import { eventTitle, record, replaySteps, stepStatus, stepTone } from './replayPresentation'
import type { ReplayRun, ReplayEvent } from './replayPresentation'
import './product-timeline.css'

const fieldLabels: Record<string, string> = {
  message: '本轮问题', query: '检索问题', rewritten_query: '整理后的问题', rewritten_question: '整理后的问题',
  intent: '识别出的意图', current_intent: '本轮意图', task_intent: '任务目标', route: '执行路线',
  selected_tools: '选用工具', evidence_count: '证据条数', retrieval_candidate_count: '候选资料数',
  retrieval_query_count: '检索问题数', evidence_retry_count: '补充检索次数', safety_flags: '风险提示',
  unsupported_claim_count: '尚无依据的结论数', quarantined_evidence_count: '已隔离的资料数',
  missing_evidence_types: '待补充证据', selected_sources: '选用来源', needs_retrieval: '是否需要检索',
  safety_review_status: '安全检查状态', answer: '回答', summary: '记录摘要', detail: '步骤说明',
}
const valueLabels: Record<string, string> = { clinical_rag_retriever: '临床资料检索', guideline_management: '临床指南与管理建议', pass: '通过', fail: '失败', skipped: '已跳过', completed: '完成', clarification: '澄清信息' }
function valueText(value: unknown): string {
  if (typeof value === 'string') return valueLabels[value] || value
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value) && value.every(v => ['string', 'number'].includes(typeof v))) return value.length ? value.map(valueText).join('、') : '无'
  return ''
}
function Facts({ value }: { value: unknown }) {
  let data = value
  if (typeof data === 'string') { const original = data; try { data = JSON.parse(data) } catch { return <p className="pt-text">{original}</p> } }
  const fields = Object.entries(record(data)).flatMap(([key, val]) => fieldLabels[key] && valueText(val) && (key !== 'summary' || /\p{Script=Han}/u.test(valueText(val))) ? [[fieldLabels[key], valueText(val)]] : [])
  return fields.length ? <dl className="pt-facts">{fields.map(([label, value], i) => <div key={i}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p className="pt-empty">未保存可直接展示的摘要；已保存字段可在技术详情中查看。</p>
}
function RawEvent({ events }: { events: ReplayEvent[] }) {
  return <details className="pt-raw"><summary>技术详情 · 原始事件</summary>{events.map(e => <div key={e.seq}><small>事件 #{e.seq} · {e.node} · {e.kind}</small><pre>{JSON.stringify(e, null, 2)}</pre></div>)}</details>
}
function Action({ title, description, status, sources }: { title: string; description?: string; status: string; sources: ReplayEvent[] }) {
  const source = sources.find(e => e.kind === 'business_step') || sources[0]
  const p = record(source?.payload)
  const duration = p.latency_ms
  const summary = description && /\p{Script=Han}/u.test(description) ? description : ''
  return <details className={`pt-action ${stepTone(status)}`}>
    <summary><i/><span><strong>{title}</strong>{summary && <small>{summary}</small>}</span><em>{['running','started','active','in_progress'].includes(status) ? '开始事件' : stepStatus(status)}</em><ChevronDown size={15}/></summary>
    <div className="pt-detail">{typeof duration === 'number' && <p className="pt-time">记录耗时 {duration < 1000 ? `${duration} 毫秒` : `${(duration / 1000).toFixed(2)} 秒`}</p>}
      {p.input_summary !== undefined && <section><h4>这一步收到什么</h4><Facts value={p.input_summary}/></section>}
      <section><h4>这一步记录了什么</h4><Facts value={p.output_summary ?? p.payload ?? p}/></section>
      {p.input_summary === undefined && <p className="pt-empty">此事件未单独保存步骤输入。</p>}
      <RawEvent events={sources}/>
    </div>
  </details>
}
export default function ProductTimeline({ run }: { run: ReplayRun }) {
  const events = run.events || []
  const turns = run.case?.turns?.length ? run.case.turns : [{ message: run.case?.message || '' }]
  return <div className="product-timeline"><p className="pt-intro">按真实记录回看处理过程。点开动作查看详情，再展开技术证据。</p>
    {turns.map((turn, index) => {
      const current = turns.length > 1 ? events.filter(e => record(e.payload).turn_index === index + 1) : events
      const steps = replaySteps({ ...run, events: current })
      return <section className="pt-turn" key={index}>
        {turns.length > 1 && <h3>第 {index + 1} 轮</h3>}
        <div className="pt-input"><MessageSquare size={16}/><div><strong>用户提出问题</strong><p>{turn.message || '此记录未保存用户输入。'}</p></div></div>
        {steps.map(step => {
          const sources = current.filter(e => String(e.seq) === step.key || e.seq === step.seq)
          return <Action key={step.key} title={step.title} description={step.description} status={step.status} sources={sources}/>
        })}
        {!steps.length && <p className="pt-empty">此轮没有可用的业务步骤记录，无法据此还原内部动作。</p>}
      </section>
    })}
    <details className="pt-audit"><summary>评测准备与完整记录 <span>{events.length} 条原始事件</span></summary><p className="pt-empty">保留准备、导入、业务步骤及评审的全部事件；“开始事件”表示当时发生了动作，不表示现在仍在运行。</p>{events.map(e => <Action key={e.seq} title={eventTitle(e)} status={e.status} sources={[e]}/>)}</details>
  </div>
}
