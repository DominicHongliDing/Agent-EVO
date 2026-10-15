import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown, Layers3, Search } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ContentTransition } from './Motion'
import ProductTimeline from './ProductTimeline'
import EvidenceWorkbench from './EvidenceWorkbench'
import { answerParts, record, replaySources, text } from './replayPresentation'
import type { ReplayRun } from './replayPresentation'
import { loadSnapshot, snapshotRequest } from './publicSnapshot'
import './clinical-showcase.css'

const exampleId = 'run_c0a39b1970e24bce9dc55e0dbf83e043'
type Finding = { dimension: string; result: string; rationale: string; critical: number; evidence?: string[]; evaluator?: string }
type ClinicalRun = Omit<ReplayRun, 'verdicts'> & { model_calls: number; trace_id: string; case?: ReplayRun['case'] & { title?: string; category?: string }; verdicts?: Finding[] }
type Snapshot = Awaited<ReturnType<typeof loadSnapshot>>
type View = 'example' | 'records' | 'method'
type Tab = 'replay' | 'timeline' | 'diagnosis' | 'output'
const dimension: Record<string, string> = { business_execution: '业务执行', live_model: '模型调用证据', retrieval_plan: '检索计划', retrieval_execution: '检索执行', retrieval: '材料质量', source_selection: '材料选择', intent: '意图识别', evidence_sufficiency: '证据充分性', critical_safety: '关键安全', context: '多轮上下文', context_session: '会话关联', context_model_evidence: '逐轮调用证据', context_correction: '采用用户更正', context_fact_retention: '记住前文事实', context_topic_return: '切回原任务', recorded_answer: '回答完整性' }
const categories: Record<string, string> = { clarification: '信息澄清', intent: '意图识别', retrieval: '资料检索', safety: '安全边界', source_selection: '来源选择', context: '多轮上下文' }
function route() {
  const q = new URLSearchParams(location.search)
  const view: View = q.get('view') === 'method' ? 'method' : ['batches','issues','records'].includes(q.get('view') || '') || q.has('batch') || (q.get('run') && q.get('run') !== exampleId) ? 'records' : 'example'
  const t = q.get('tab')
  return { view, run: q.get('run') || (view === 'example' ? exampleId : ''), batch: q.get('batch') || '', tab: (['timeline','diagnosis','output'].includes(t || '') ? t : 'replay') as Tab }
}
function Result({ value }: { value: string }) { return <span className={`cs-result ${value}`}>{value === 'pass' ? '通过' : value === 'fail' ? '发现问题' : '待判断'}</span> }
function Body({ content }: { content: string }) { return <div className="cs-prose"><Markdown remarkPlugins={[remarkGfm]} disallowedElements={['img']} components={{ a: ({ href, children }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span> }}>{content}</Markdown></div> }
function Conversation({ run }: { run: ClinicalRun }) {
  const turns = run.case?.turns?.length ? run.case.turns : [{ message: run.case?.message || '' }]
  const rows = Array.isArray(run.output?.conversation_turns) ? run.output.conversation_turns.map(record) : []
  const sources = replaySources(run)
  return <div className="cs-conversation">{turns.map((turn, i) => {
    const row = rows.find(r => r.turn_index === i + 1)
    const parts = answerParts({ ...run, output: turns.length > 1 ? record(row?.output) : run.output })
    return <section className="cs-turn" key={i}>
      {turns.length > 1 && <div className="cs-turn-label">第 {i + 1} 轮</div>}
      <div className="cs-question"><span>用户</span><p>{turn.message || '此记录未保存输入。'}</p></div>
      <div className="cs-answer"><span>Clinical Agent <small>已保存的回答原文</small></span>{parts.length ? parts.map((part, n) => <div key={n}>{part.title && <h4>{part.title}</h4>}<Body content={part.content}/></div>) : <p className="cs-muted">未保存可展示的完整回答，请查看原始证据。</p>}</div>
    </section>
  })}{!!run.case?.case_context_text && <details className="cs-disclosure"><summary>输入的病例上下文</summary><Body content={run.case.case_context_text}/></details>}
    {sources.length > 0 && <details className="cs-disclosure"><summary>本次引用资料 · {sources.length} 条</summary>{sources.map(s => <article key={s.key}><h4>{s.title}</h4><p>{s.excerpt}</p><small>{s.reference} {s.version}</small></article>)}</details>}
  </div>
}
export function Conclusions({ run, writable = false }: { run: ClinicalRun; writable?: boolean }) {
  const findings = run.verdicts || []
  const diagnosis = record(run.events?.find(e => e.node === 'diagnosis')?.payload)
  const details = Array.isArray(diagnosis.findings) ? diagnosis.findings.map(record) : []
  const groups = [{ title: '关键安全', rows: findings.filter(v => v.critical) }, { title: '发现的问题', rows: findings.filter(v => !v.critical && v.result === 'fail') }, { title: '还需要判断', rows: findings.filter(v => !v.critical && v.result === 'unjudged') }, { title: '已通过的检查', rows: findings.filter(v => !v.critical && v.result === 'pass') }]
  return <div className="cs-conclusions"><EvidenceWorkbench key={run.run_id} run={run} writable={writable}/><p className="cs-muted">规则检查、模型评审与人工复核分别保留。待判断不算通过；以下为工程评测。</p>{groups.map((g, index) => g.rows.length > 0 && <details key={g.title} open={index < 2} className="cs-finding-group"><summary>{g.title}<span>{g.rows.length} 项</span><ChevronDown size={15}/></summary>{g.rows.map((f, i) => {
    const d = details.find(d => d.dimension === f.dimension && d.rationale === f.rationale)
    return <article className="cs-finding" key={i}><header><strong>{dimension[f.dimension] || '其他评测项'}</strong><Result value={f.result}/></header><p>{f.rationale}</p><small>{f.evaluator === 'human' ? '人工复核' : f.evaluator?.includes('semantic') || f.evaluator?.includes('judge') ? '模型辅助评审 · 待人工复核' : '已保存的评测结果'}</small>
      <details><summary>判断依据与排查建议</summary>{d && <>{!!d.hypothesis && <p><b>疑似原因：</b>{text(d.hypothesis)}</p>}{!!d.alternative && <p><b>其他可能：</b>{text(d.alternative)}</p>}{!!d.controlled_replay && <p><b>如何验证：</b>{text(d.controlled_replay)}</p>}</>}{f.evidence?.map((e, n) => <blockquote key={n}>{e}</blockquote>)}{!d?.hypothesis && <p>该判断尚不能独立确定根因。需要结合处理过程，并固定输入与版本创建新的运行进行对照。</p>}</details>
    </article>
  })}</details>)}{!findings.length && <p>尚无已保存的评测结论。</p>}</div>
}
export default function ClinicalShowcase() {
  const [locationState, setLocationState] = useState(route), [snapshot, setSnapshot] = useState<Snapshot>(), [run, setRun] = useState<ClinicalRun>(), [error, setError] = useState(''), [reload, setReload] = useState(0)
  const [search, setSearch] = useState(''), [filter, setFilter] = useState(new URLSearchParams(location.search).get('view') === 'issues' ? 'fail' : 'all')
  const { view, tab, batch, run: selectedId } = locationState
  const workspaceScroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { workspaceScroll.current?.scrollTo({ top: 0, left: 0 }) }, [view])
  useEffect(() => { const pop = () => setLocationState(route()); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop) }, [])
  useEffect(() => { let active = true; loadSnapshot().then(s => { if (active) setSnapshot(s) }).catch(e => { if (active) setError(e.message) }); return () => { active = false } }, [reload])
  useEffect(() => { let active = true; setRun(undefined); setError(''); if (selectedId) snapshotRequest<ClinicalRun>(`/runs/${selectedId}`).then(r => { if (active) setRun(r) }).catch(e => { if (active) setError(e.message) }); return () => { active = false } }, [selectedId, reload])
  function go(next: Partial<typeof locationState>) {
    const state = { ...locationState, ...next }, q = new URLSearchParams()
    q.set('space', 'history'); q.set('view', state.view === 'example' ? 'story' : state.view === 'records' ? 'batches' : 'method')
    if (state.run) q.set('run', state.run); if (state.batch) q.set('batch', state.batch); if (state.tab !== 'replay') q.set('tab', state.tab)
    if (new URLSearchParams(location.search).get('embed') === '1') q.set('embed', '1')
    history.pushState(null, '', `?${q}`); setLocationState(state)
  }
  const currentBatch = snapshot?.batches.find(b => b.batch_id === (batch || snapshot.batches.find(b => b.runs.some((r: { run_id: string }) => r.run_id === selectedId))?.batch_id || snapshot.primary_batch_id))
  const allRows = (currentBatch?.runs || []).map((r: Record<string, any>) => snapshot!.runs[r.run_id])
  const rows = allRows.filter((r: Record<string, any>) => `${r.case.title} ${r.case.message} ${r.case_id}`.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || r.verdicts.some((v: Finding) => v.result === filter)))
  const detail = <>{error ? <div className="cs-error" role="alert"><h3>暂时无法读取记录</h3><p>{error}</p><button onClick={() => setReload(n => n + 1)}>重新读取</button></div> : !run ? <div className="cs-loading" role="status">正在读取真实运行记录…</div> : <>
    <header className="cs-detail-heading"><div><span className="cs-kicker">{view === 'example' ? '一个实际发生的多轮失败' : categories[run.case?.category || ''] || 'Clinical 工程记录'}</span><h2>{view === 'example' ? '用户更正了，回答跟上了吗？' : run.case?.title || '评测记录'}</h2></div><span className="cs-saved">已保存</span></header>
    {view === 'example' && <p className="cs-detail-intro">用户把“两周”改为“三天”，再要求总结。对话完成了，但上下文更正评审发现了问题。下面可以直接核对每轮原文。</p>}
    <div className="cs-detail-tabs" role="tablist" aria-label="记录详情">{([['replay','对话'],['timeline','处理过程'],['diagnosis','评测结论']] as const).map(([id, label], i) => <button id={`cs-tab-${id}`} key={id} role="tab" aria-controls="cs-panel" aria-selected={tab === id} tabIndex={tab === id || tab === 'output' && i === 0 ? 0 : -1} onClick={() => go({ tab: id })} onKeyDown={e => { if (['ArrowLeft','ArrowRight'].includes(e.key)) { e.preventDefault(); const next = (['replay','timeline','diagnosis'] as const)[(i + (e.key === 'ArrowRight' ? 1 : 2)) % 3]; go({ tab: next }); document.getElementById(`cs-tab-${next}`)?.focus() } }}>{label}</button>)}</div>
    <ContentTransition identity={`${selectedId}-${tab}`} variant={tab === 'replay' ? 'conversation' : 'page'}><div className="cs-panel" id="cs-panel" role="tabpanel" aria-label={tab === 'replay' ? '对话' : tab === 'timeline' ? '处理过程' : tab === 'diagnosis' ? '评测结论' : '技术证据'} key={`${selectedId}-${tab}`}>
      {tab === 'replay' && <Conversation run={run}/>}{tab === 'timeline' && <ProductTimeline run={run}/>}{tab === 'diagnosis' && <Conclusions run={run}/>}
      <details className="cs-technical" open={tab === 'output' || undefined}><summary>技术证据 · 原始输出与完整事件</summary><dl><dt>运行记录</dt><dd>{run.run_id}</dd><dt>追踪编号</dt><dd>{run.trace_id}</dd><dt>历史业务模型调用</dt><dd>{run.model_calls} 次</dd></dl><pre>{JSON.stringify(run, null, 2)}</pre></details>
    </div></ContentTransition>
  </>}</>
  return <div className="cs-app"><header className="cs-top"><a className="cs-brand" href="/" target="_top"><Layers3 size={22}/><strong>Agent EVO</strong><span>Clinical 案例</span></a><a className="cs-home" href="/" target="_top">返回主页 <ArrowUpRight size={14}/></a></header>
    <div className="cs-main"><div className="cs-page-heading"><div><span className="cs-kicker">从回答，看到问题所在</span><h1>让 Agent 的每一步都有依据。</h1><p>以 Clinical 为例，回看真实运行，理解判断依据，找到下一步改进方向。</p></div><a className="cs-try" href="?space=mine&view=datasets">自己跑一次评测 <ArrowUpRight size={15}/></a></div>
      <nav className="cs-nav" aria-label="评测浏览">{([['example','案例导览'],['records','评测记录'],['method','如何评测']] as const).map(([id, label]) => <button key={id} aria-current={view === id ? 'page' : undefined} onClick={() => go({ view: id, run: id === 'example' ? exampleId : '', tab: 'replay' })}>{label}</button>)}<span>Clinical · 已保存的工程证据</span></nav>
      <div className="cs-workspace" ref={workspaceScroll} role="region" aria-label="案例内容" tabIndex={0}><ContentTransition identity={view} variant="page">
      {view === 'example' && <div className="cs-example"><aside className="cs-guide"><span className="cs-kicker">从一个问题开始</span><h2>“不是两周，<br/>是三天。”</h2><p>多轮对话里，记住旧信息还不够；Agent 也要跟上用户的新信息。</p><ol><li><button onClick={() => go({tab:'replay'})}><span>01</span><div><strong>先看实际对话</strong><small>问题是什么，回答了什么</small></div><ArrowRight size={15}/></button></li><li><button onClick={() => go({tab:'timeline'})}><span>02</span><div><strong>回看处理动作</strong><small>理解、检索、生成与检查</small></div><ArrowRight size={15}/></button></li><li><button onClick={() => go({tab:'diagnosis'})}><span>03</span><div><strong>核对判断依据</strong><small>发现的问题与仍未知的原因</small></div><ArrowRight size={15}/></button></li></ol><div className="cs-guide-note">这个案例保留了失败。尚无修复后的受控重跑记录。</div><button className="cs-more" onClick={() => go({ view:'records',run:'',tab:'replay' })}>浏览全部 50 条主批次记录 <ArrowRight size={14}/></button></aside><section className="cs-detail">{detail}</section></div>}
      {view === 'records' && <><div className="cs-toolbar"><label>批次<select value={currentBatch?.batch_id || ''} onChange={e => { setSearch(''); setFilter('all'); go({batch:e.target.value,run:'',tab:'replay'}) }}>{snapshot?.batches.map(b => <option key={b.batch_id} value={b.batch_id}>{b.batch_id === snapshot.primary_batch_id ? '主批次 · 50 条记录' : b.label}</option>)}</select></label><label className="cs-search"><Search size={15}/><input aria-label="搜索问题或记录" placeholder="搜索问题或记录…" value={search} onChange={e => setSearch(e.target.value)}/></label><select aria-label="筛选评测结果" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部结果</option><option value="fail">含失败项</option><option value="unjudged">含待判断项</option></select></div><div className="cs-record-stats"><span>{rows.length} / {allRows.length} 条</span><span>质量失败 {allRows.filter((r: any) => r.verdicts.some((v: Finding) => v.result === 'fail')).length}</span><span>关键安全失败 {allRows.filter((r: any) => r.verdicts.some((v: Finding) => v.critical && v.result === 'fail')).length}</span><span>安全待判断 {allRows.filter((r: any) => r.verdicts.some((v: Finding) => v.critical && v.result === 'unjudged')).length}</span></div>
        <div className={`cs-record-layout ${selectedId ? 'with-detail' : ''}`}><section className="cs-record-list" aria-label="评测记录列表">{!snapshot && !error && <p role="status">正在读取记录列表…</p>}{error && !selectedId && <p role="alert">{error}<button onClick={() => setReload(n => n + 1)}>重试</button></p>}{rows.map((r: any, index: number) => { const fails = r.verdicts.filter((v: Finding) => v.result === 'fail').length, pending = r.verdicts.filter((v: Finding) => v.result === 'unjudged').length; return <button className={`cs-record-row ${r.run_id === selectedId ? 'selected' : ''}`} key={r.run_id} onClick={() => go({run:r.run_id,tab:'replay'})}><span className="cs-row-number">{String(index + 1).padStart(2,'0')}</span><span className="cs-row-body"><strong>{r.case.title}</strong><small>{r.case.turns?.[0]?.message || r.case.message}</small><em>{r.status === 'completed' ? '执行完成' : '执行未完成'} · {r.model_calls} 次历史模型调用</em></span><span className="cs-row-result"><Result value={fails ? 'fail' : pending ? 'unjudged' : 'pass'}/><small>{fails ? `${fails} 项失败` : pending ? `${pending} 项待判断` : '已检查项通过'}</small></span><ArrowRight size={15}/></button> })}{snapshot && !rows.length && <div className="cs-empty">没有匹配的记录。<button onClick={() => {setSearch('');setFilter('all')}}>清除筛选</button></div>}</section>{selectedId && <section className="cs-detail"><button className="cs-back" onClick={() => go({run:'',tab:'replay'})}><ArrowLeft size={14}/> 返回记录列表</button>{detail}</section>}</div></>}
      {view === 'method' && <section className="cs-method"><span className="cs-kicker">从真实业务入口到可复核的结论</span><h2>Agent 在哪里运行，<br/>评测就在哪里执行。</h2><p>当前案例由本地执行器调用 Clinical 业务后端，保存对话、步骤、模型用量与评测结论。官网展示这些已经保存的记录。</p><div className="cs-flow"><div><span>01</span><strong>准备问题与标准</strong><p>固定用例、版本和逐轮要求。</p></div><ArrowRight size={17}/><div><span>02</span><strong>调用真实 Agent</strong><p>沿用同一会话，记录中间步骤。</p></div><ArrowRight size={17}/><div><span>03</span><strong>判断并追溯</strong><p>规则、语义评审与人工复核分开。</p></div></div><div className="cs-method-columns"><article><h3>本地运行，线上查看</h3><p>在本机选择测试集，用内置方式或自己的脚本调用 Clinical。平台保存每轮回答与处理过程，确认脱敏后再同步到线上结果空间。Agent 可以继续保留在本机。</p><p className="cs-muted">公开示例展示已保存的记录；私有结果同步需要单独配置连接与登录服务。</p></article><article><h3>新 Agent 怎样接入？</h3><p>连接它的业务函数或接口，关联每轮会话，并记录意图、检索、工具与回答。只有最终文本，可以评回答质量；要定位“哪一步错”，还需要对应的过程证据。</p><p className="cs-muted">当前以 Clinical 为内置示例。本地执行与线上结果查看分别运行，工程评分与临床验证分别呈现。</p></article></div><details className="cs-disclosure"><summary>这次界面参考了哪些开源工具？</summary><p><a href="https://github.com/langfuse/langfuse" target="_blank" rel="noreferrer">Langfuse</a> 的记录追溯、<a href="https://github.com/promptfoo/promptfoo" target="_blank" rel="noreferrer">Promptfoo</a> 的逐例结果检查。沿用已有业务证据与组件，未复制第三方源码。</p></details></section>}
      </ContentTransition></div>
      <footer className="cs-footer"><span>Clinical 合成工程场景 · 医生临床验证尚未开展</span><span>浏览记录不会调用模型</span></footer>
    </div>
  </div>
}
