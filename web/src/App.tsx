import { useEffect, useState } from 'react'
import RunReplay from './RunReplay'
import EvidenceWorkbench from './EvidenceWorkbench'
import ProductTimeline from './ProductTimeline'
import Workspace from './Workspace'
import DatasetHub from './DatasetHub'
import WorkspaceFrame from './WorkspaceFrame'
import ResultOperations from './ResultOperations'
import LocalEvaluations from './LocalEvaluations'
import EvaluationStart from './EvaluationStart'
import AgentWorkbench from './AgentWorkbench'
import AnswerRecords from './AnswerRecords'
import { AnimatePresence, MotionDialog, ContentTransition } from './Motion'
import type { Panel, ManagedBatch } from './Workspace'
import { api } from './api'
import { publicMode, personalMode, localOnlyTitle } from './publicSnapshot'
import PersonalControls, { WorkspaceScope, PersonalRuntime } from './PersonalControls'
import { PublicNotice } from './PublicEvidence'
import { Activity, AlertTriangle, ArrowRight, Bot, CheckCircle2, ChevronRight, CircleDashed, Clock3, Database, Download, FileText, FlaskConical, GitCompareArrows, Layers3, Settings2, Play, RefreshCw, ShieldAlert, X } from 'lucide-react'

type Agent = 'unihr' | 'clinical' | 'generic'
type Case = { case_id: string; agent: Agent; category: string; title: string; message: string; case_context_text?: string; turns?: { message: string }[]; fixtures?: unknown[]; risk_level: string; gold_status: string; expected: Record<string, unknown>; sha256: string }
type Event = { seq: number; kind: string; node: string; status: string; created_at: string; payload: unknown }
type Verdict = { verdict_id: string; dimension: string; evaluator: string; result: string; rationale: string; critical: number; evidence: string[]; reviewer?: string }
type Artifact = { artifact_id: string; filename: string; byte_size: number; sha256: string; checks: Record<string, unknown> }
type Run = { run_id: string; batch_id: string; case_id: string; status: string; execution_mode?: string; started_at?: string; finished_at?: string; model_calls: number; model_evidence: Record<string, unknown>; business_execution_id?: string; business_run_id?: string; error_code?: string; trace_id: string; agent_name?: string; output?: Record<string, unknown>; case?: Case; events?: Event[]; verdicts?: Verdict[]; artifacts?: Artifact[]; version?: Record<string, unknown>; retry_of?: string }
type Batch = ManagedBatch
type Health = { platform: string; services: Record<string, { reachable: boolean; error?: string; http_status?: number }>; unihr_credentials_configured: boolean; unihr_usage_db_configured: boolean; unihr_knowledge?: { configured: boolean; source_count: number; chunk_count: number; snapshot_sha256?: string }; worker: { worker_id?: string; seen_at?: string } }


const statusLabel: Record<string, string> = { queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', timed_out: '超时', blocked: '环境阻塞', cancelled: '已取消', pass: '通过', fail: '失败', unjudged: '待判断' }
const dimensionLabel: Record<string, string> = { recorded_model: '历史模型证据', recorded_answer: '回答完整性', context_session: '会话关联', context_model_evidence: '逐轮模型证据', context_semantics: '语义上下文', context_fact_retention: '事实保留', context_correction: '信息更正', context_constraint: '约束延续', context_topic_return: '话题返回', context_isolation: '对象隔离', context_risk_handoff: '风险交接',  business_node: '失败节点', business_execution: '业务执行', live_model: '真实模型', intent: '意图识别', context: '多轮上下文', retrieval_plan: '检索计划', retrieval_execution: '检索执行', retrieval: '材料质量', source_selection: '来源选择', evidence_sufficiency: '证据充分性', artifact: '文件产物', critical_safety: '关键安全' }
const fmt = (date?: string) => date ? new Date(date).toLocaleString('zh-CN', { hour12: false }) : '—'
const short = (id?: string) => id ? id.slice(0, 12) : '—'
const json = (value: unknown) => JSON.stringify(value, null, 2)

function Badge({ value, critical = false }: { value: string; critical?: boolean }) { return <span className={`badge ${value} ${critical ? 'critical' : ''}`}>{statusLabel[value] || value}</span> }

const panelFromLocation = (): Panel => {
  const p = new URLSearchParams(location.search), value = p.get('view')
  if (value === 'agents' || p.get('space') === 'scripts') return 'evaluate'
  return ['overview','evaluate','settings','datasets','cases','batches','issues'].includes(value || '') ? value as Panel : publicMode ? 'overview' : 'evaluate'
}
function recordsFromLocation(){const p=new URLSearchParams(location.search);return p.get('source')==='projects'?'projects':p.get('source')==='answers'?'answers':'native'}
function App() {
  const [startKey, setStartKey] = useState(0)
  const [datasetLibrary,setDatasetLibrary]=useState(new URLSearchParams(location.search).get('library')==='legacy'?'legacy':'projects')
  const [recordSource, setRecordSource] = useState(recordsFromLocation)
  const [answerBatch, setAnswerBatch] = useState(new URLSearchParams(location.search).get('answer_batch') || '')
  const [selection, setSelection] = useState<{ datasetId: string; caseIds: string[] }>()
  const [cases, setCases] = useState<Case[]>([])
  const [batches, setBatches] = useState<Batch[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [activeBatch, setActiveBatch] = useState<string>(new URLSearchParams(location.search).get('batch') || '')
  const [detailId, setDetailId] = useState<string>(new URLSearchParams(location.search).get('run') || '')
  const [detail, setDetail] = useState<Run | null>(null)
  const [panel, setPanel] = useState<Panel>(panelFromLocation)
  const [issueDimension, setIssueDimension] = useState(new URLSearchParams(location.search).get('dimension') || '')
  const [criticalOnly, setCriticalOnly] = useState(new URLSearchParams(location.search).get('critical') === 'true')
  const [registry, setRegistry] = useState<{ agent_id: string; name: string; adapter_kind: string; dataset_ids: string[] }[]>([])
  const [datasetCount, setDatasetCount] = useState(0)
  const [detailTab, setDetailTab] = useState<'replay' | 'diagnosis' | 'timeline' | 'output' | 'artifacts' | 'actions'>(() => {
    const value = new URLSearchParams(location.search).get('tab')
    return value === 'diagnosis' || value === 'timeline' || value === 'output' || value === 'artifacts' ? value : 'replay'
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tokenInput, setTokenInput] = useState('')
  const [reviewText, setReviewText] = useState('')
  const [reviewer, setReviewer] = useState('')
  const [comparison, setComparison] = useState<{ comparable: boolean; reason?: string; left: { run: Run; verdicts: Verdict[] }; right: { run: Run; verdicts: Verdict[] } } | null>(null)

  const navigate = (next: Panel, batch = activeBatch, dimension = issueDimension, critical = criticalOnly) => {
    if (next === 'agents') next = 'evaluate'
    const params = new URLSearchParams({ space: personalMode ? 'mine' : publicMode ? 'history' : 'native', view: next }); if (new URLSearchParams(location.search).get('embed') === '1') params.set('embed', '1'); if (batch && ['batches','issues'].includes(next)) params.set('batch', batch)
    if (next === 'issues') { if (dimension) params.set('dimension', dimension); if (critical) params.set('critical','true') }
    history.pushState(null, '', `${location.pathname}?${params}`); setPanel(next)
  }
  const openRecordSource = (source:string) => {setRecordSource(source);const example=batches.find(b=>b.total===50&&b.runs.every(r=>r.agent==='clinical'));if(source==='native'&&example)setActiveBatch(example.batch_id);navigate('batches',source==='native'&&example?example.batch_id:activeBatch);const p=new URLSearchParams(location.search);p.set('source',source);if(source==='projects')p.delete('batch');history.replaceState(null,'',`${location.pathname}?${p}`)}
  const openAnswerBatch = (id: string) => { const p = new URLSearchParams(location.search); p.set('space', personalMode ? 'mine' : 'native'); p.set('view', 'batches'); p.set('source', 'answers'); p.delete('batch'); if (id) p.set('answer_batch', id); else p.delete('answer_batch'); history.pushState(null, '', `${location.pathname}?${p}`); setAnswerBatch(id); setRecordSource('answers'); setPanel('batches') }
  useEffect(() => { const pop = () => { const p = new URLSearchParams(location.search); setRecordSource(recordsFromLocation()); setAnswerBatch(p.get('answer_batch') || ''); setDatasetLibrary(p.get('library')==='legacy'?'legacy':'projects') }; window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop) }, [])
  const selectBatch = (id: string) => { setActiveBatch(id); const params = new URLSearchParams(location.search); if (id) params.set('batch',id); else params.delete('batch'); history.replaceState(null,'',`${location.pathname}?${params}`) }
  const openIssues = (dimension: string, critical = false) => { setIssueDimension(dimension); setCriticalOnly(critical); navigate('issues', activeBatch, dimension, critical) }
  useEffect(() => { const pop = () => { const p = new URLSearchParams(location.search); const next=p.get('view'); setPanel(panelFromLocation()); setActiveBatch(p.get('batch') || ''); setIssueDimension(p.get('dimension') || ''); setCriticalOnly(p.get('critical') === 'true') }; window.addEventListener('popstate',pop); return () => window.removeEventListener('popstate',pop) }, [])

  const refresh = async () => {
    try {
      const [c, b, a, d] = await Promise.all([api<{ items: Case[] }>('/cases'), api<{ items: Batch[] }>('/batches'), api<{ items: typeof registry }>('/agents'), api<{ items: unknown[] }>('/datasets')])
      setCases(c.items); setBatches(b.items); setRegistry(a.items); setDatasetCount(d.items.length)
      setActiveBatch(old => b.items.some(row => row.batch_id === old) ? old : b.items.find(row=>row.total===50&&row.runs.every(r=>r.agent==='clinical'))?.batch_id || b.items[0]?.batch_id || '')
      setError('')
    } catch (e) { setError(String(e)) }
  }
  const refreshHealth = () => api<Health>('/health').then(setHealth).catch(e => setError(String(e)))
  useEffect(() => { refresh(); const timer = publicMode ? undefined : window.setInterval(refresh, 2500); return () => window.clearInterval(timer) }, [])
  useEffect(() => { if (!publicMode && !personalMode && panel !== 'overview') return; refreshHealth(); const timer = publicMode ? undefined : window.setInterval(refreshHealth, 10000); return () => window.clearInterval(timer) }, [panel])
  useEffect(() => {
    if (!detailId) { setDetail(null); return }
    let disposed = false
    setDetail(null)
    const load = () => api<Run>(`/runs/${detailId}`).then(run => { if (!disposed) setDetail(run) }).catch(e => { if (!disposed) { setError(String(e)); setDetailId('') } })
    load(); const timer = publicMode ? undefined : window.setInterval(load, 1600); return () => { disposed = true; window.clearInterval(timer) }
  }, [detailId])
  useEffect(() => {
    if (!detail?.retry_of) { setComparison(null); return }
    api<typeof comparison>(`/compare?left=${encodeURIComponent(detail.retry_of)}&right=${encodeURIComponent(detail.run_id)}`).then(setComparison).catch(() => setComparison(null))
  }, [detail?.retry_of, detail?.run_id, detail?.status])

  const currentBatch = batches.find(b => b.batch_id === activeBatch)
  const runRows = currentBatch?.runs || []
  const failures = runRows.filter(r => ['failed', 'timed_out', 'blocked'].includes(r.status)).length
  const running = runRows.filter(r => r.status === 'running').length
  const critical = cases.filter(c => c.risk_level === 'critical').length
  const retry = async () => { if (!detailId) return; setBusy(true); try { const next = await api<Run>(`/runs/${detailId}/retry`, { method: 'POST' }); setDetailId(next.run_id); await refresh() } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  const cancel = async () => { if (!detailId) return; setBusy(true); try { await api(`/runs/${detailId}/cancel`, { method: 'POST' }); await refresh() } catch (e) { setError(String(e)) } finally { setBusy(false) } }
  const review = async (result: 'pass' | 'fail' | 'unjudged') => {
    if (!detailId || !reviewer.trim() || !reviewText.trim()) return
    setBusy(true)
    try { await api(`/runs/${detailId}/review`, { method: 'POST', body: json({ dimension: detail?.case?.agent === 'clinical' ? 'clinical_human_review_unverified' : 'business_human_review', result, rationale: reviewText, reviewer }) }); setReviewText(''); setDetail(await api<Run>(`/runs/${detailId}`)) } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }
  const diagnosis = detail?.events?.filter(e => e.node === 'diagnosis').slice(-1)[0]?.payload as { findings?: { dimension: string; status: string; rationale: string; critical: boolean; evidence: string[]; hypothesis?: string; alternative?: string; controlled_replay?: string }[] } | undefined

  return <><WorkspaceFrame pageKey={panel} title={{overview:'评测总览',agents:'新建评测',evaluate:'开始评测',settings:'设置',datasets:'测试集管理',cases:'选择用例',batches:'评测记录',issues:'失败问题'}[panel]} onHome={() => navigate('overview')} onRefresh={refresh} navigation={<>
      <div className="brand"><div className="brand-mark"><Layers3 size={23} /></div><div><strong>Agent EVO</strong><small>评测与改进</small></div></div>
      <button className="side-section" onClick={() => navigate('overview')} title="返回评测总览">工作空间</button>
      {publicMode && <button className={`nav ${panel === 'overview' ? 'active' : ''}`} onClick={() => navigate('overview')}><Activity size={18}/> 总览 <ChevronRight size={15}/></button>}
      <button className={`nav ${panel === 'evaluate' ? 'active' : ''}`} onClick={() => { setStartKey(k => k+1); setSelection(undefined); navigate('evaluate') }}><Play size={18}/> 开始评测 <ChevronRight size={15}/></button>
      <button className={`nav ${['datasets','cases'].includes(panel) ? 'active' : ''}`} onClick={() => navigate('datasets')}><FlaskConical size={18}/> 测试集 {publicMode&&<span>{datasetCount}</span>}</button>
      <button className={`nav ${panel === 'batches' ? 'active' : ''}`} onClick={() => recordSource === 'answers' && !publicMode ? openAnswerBatch(answerBatch) : publicMode ? navigate('batches') : openRecordSource(recordSource)}><Database size={18}/> 评测记录 <ChevronRight size={15}/></button>
      {publicMode && <button className={`nav ${panel === 'issues' ? 'active' : ''}`} onClick={() => openIssues('')}><AlertTriangle size={18}/> 问题排查 <ChevronRight size={15}/></button>}
      <div className="side-section second">内置示例</div>
      {registry.map(a => <div className="agent-state" key={a.agent_id}><span className={`status-dot ${['agent_unihr','agent_clinical'].includes(a.agent_id) && health?.services[a.adapter_kind]?.reachable ? 'on' : ''}`}/><div><strong>{a.name}</strong><small>用问题验证回答与上下文</small></div></div>)}
      {!publicMode && !personalMode && <button className={`nav ${panel === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')}><Settings2 size={18}/> 设置</button>}
      <div className="sidebar-bottom"><div className="pulse"><span className="status-dot on" /> {personalMode ? '我的评测 · 工作台' : publicMode ? 'Clinical 公开记录' : '平台运行中'}</div><small>工程评测 · 合成数据</small></div>
    </>}>
        <WorkspaceScope/>
        {personalMode && panel === 'cases' && <PersonalControls/>}
        {publicMode && <PublicNotice compact={panel !== 'overview'} onOpen={id => { setDetailId(id); setDetailTab('replay') }}/>}
        {error && <div className="error-banner"><AlertTriangle size={17}/>{error}{error.includes('401') && <><input type="password" aria-label="平台访问令牌" placeholder="平台访问令牌" value={tokenInput} onChange={e => setTokenInput(e.target.value)}/><button onClick={() => { window.sessionStorage.setItem('evo_access_token', tokenInput); setError(''); refresh(); refreshHealth() }}>连接</button></>}<button onClick={() => setError('')}><X size={16}/></button></div>}
        {panel === 'overview' && <>
          <div className="page-heading"><div><div className="eyebrow">EVALUATION OPERATIONS</div><h1>评测总览</h1><p>{publicMode ? '浏览本地真实评测的输入输出、完整执行链路与质量结果。' : '从真实业务入口运行测试，逐条追踪模型调用与节点证据。'}</p></div><button className="primary" onClick={() => navigate('evaluate')}><Play size={16} fill="currentColor"/> {publicMode ? '浏览示例' : '新建评测'}</button></div>
          <section className="stats"><div className="stat"><span>测试用例</span><strong>{cases.length}</strong><small>{datasetCount} 个测试集 · {registry.length} 个内置示例</small><FlaskConical /></div><div className="stat"><span>当前批次进度</span><strong>{currentBatch ? `${currentBatch.finished}/${currentBatch.total}` : '—'}</strong><small>{running} 条运行中</small><Activity /></div><div className="stat"><span>{personalMode ? '模型用量核验' : publicMode ? '原批次真实模型证据' : '本次真实模型证据'}</span><strong>{personalMode ? '未提供' : currentBatch ? `${currentBatch.live_model_verified}/${currentBatch.total}` : '—'}</strong><small>{personalMode ? '步骤与回答已保存；调用数未核验' : '以业务用量事件为准'}</small><CheckCircle2 /></div><div className="stat warning"><span>业务失败 / 阻塞</span><strong>{failures}</strong><small>{critical} 条关键风险用例，独立审查</small><ShieldAlert /></div></section>
          <div className="grid-two"><section className="card">{personalMode ? <PersonalRuntime/> : publicMode ? <><div className="card-head"><div><h2>本地运行实现</h2><p>已完成的真实业务运行，官网展示保存证据</p></div><span className="small-tag">公开只读</span></div><div className="health-row"><div><strong>Clinical Chat · 真实业务入口</strong><small>本地隔离运行，调用百炼模型，取得业务 Run ID</small></div><Badge value="pass"/></div><div className="health-row"><div><strong>FastAPI Runner + SQLite</strong><small>持久保存逐条输入、输出、模型用量与节点事件</small></div><Badge value="pass"/></div><div className="health-row"><div><strong>上下文与质量诊断</strong><small>单轮与多轮分别保存，失败与待判断如实展示</small></div><Badge value="pass"/></div><div className="health-row"><div><strong>医生临床验证</strong><small>本页为合成场景的工程评测证据</small></div><Badge value="unjudged"/></div></> : <><div className="card-head"><div><h2>Clinical 本地环境</h2><p>业务服务就绪后，即可开始真实评测</p></div><span className="small-tag">实时检查</span></div><div className="health-row"><span className={`status-dot ${health?.services.clinical?.reachable ? 'on' : ''}`}/><div><strong>Clinical Agent</strong><small>{health?.services.clinical?.reachable ? '业务接口已连接，模型结果由实际执行验证' : '本地业务服务未就绪；已保存的评测记录仍可查看'}</small></div><Badge value={health?.services.clinical?.reachable ? 'pass' : 'blocked'}/></div><p className="environment-help">评测平台与 Clinical 业务服务分别运行。使用内置方式或自定义脚本，都会调用同一个 Clinical 入口。</p><button className="outline" onClick={() => navigate('evaluate')}>准备一次评测 <ArrowRight size={14}/></button></>}</section><section className="card"><div className="card-head"><div><h2>证据链</h2><p>单条记录从输入走到归因</p></div><span className="small-tag">诊断路径</span></div><div className="pipeline"><div><span>01</span><strong>业务入口</strong><small>真实请求 / 业务 ID</small></div><ArrowRight/><div><span>02</span><strong>节点与模型</strong><small>意图 / 检索 / 工具</small></div><ArrowRight/><div><span>03</span><strong>归因与复核</strong><small>证据 / 不确定性</small></div></div><div className="notice"><ShieldAlert size={17}/> 关键安全失败单独显示，工程结论不等于医生临床验证。</div></section></div>
          <section className="card recent"><div className="card-head"><div><h2>最近批次</h2><p>{personalMode ? '运行状态自动更新；刷新会中断执行，已保存的记录可继续查看。' : publicMode ? '主批次 50 条与多轮实例分开，选择批次查看完整记录。' : '运行状态会自动更新，刷新页面仍可继续查看。'}</p></div><button className="text-button" onClick={() => navigate('batches')}>查看全部 <ArrowRight size={15}/></button></div><div className="recent-list">{batches.length ? batches.slice(0, 4).map(b => <button className="batch-item" key={b.batch_id} onClick={() => { setActiveBatch(b.batch_id); navigate('batches', b.batch_id) }}><div className="batch-icon"><Database size={19}/></div><div><strong>{b.label}</strong><small>{fmt(b.created_at)} · {b.total} 条记录</small></div><div className="batch-progress"><div style={{ width: `${b.total ? b.finished / b.total * 100 : 0}%` }}/></div><span>{b.finished}/{b.total}</span><ChevronRight size={16}/></button>) : <div className="empty"><CircleDashed size={27}/><strong>还没有评测批次</strong><span>选择合成用例后发起真实 Agent 运行。</span></div>}</div></section>
        </>}

        {panel === 'datasets' && datasetLibrary==='legacy' && !publicMode && <button className="text-button" onClick={()=>{setDatasetLibrary('projects');navigate('datasets')}}>← 返回测试集库</button>}
        {panel === 'batches' && !publicMode && <div className="ai-source-tabs" aria-label="评测记录来源"><button aria-pressed={recordSource === 'projects'} onClick={() => { openRecordSource('projects') }}>我的评测与报告</button><button aria-pressed={recordSource === 'native'} onClick={() => { openRecordSource('native') }}>Clinical 示例与历史</button><button aria-pressed={recordSource === 'answers'} onClick={() => openAnswerBatch(answerBatch)}>导入回答记录</button></div>}
        {panel === 'datasets' && datasetLibrary === 'projects' && !publicMode ? <DatasetHub onImported={openAnswerBatch} onNative={id=>{navigate('cases');const p=new URLSearchParams(location.search);p.set('dataset',id);history.replaceState(null,'',`${location.pathname}?${p}`)}} onManage={()=>{setDatasetLibrary('legacy');const p=new URLSearchParams(location.search);p.set('library','legacy');history.replaceState(null,'',`${location.pathname}?${p}`)}}/> : panel === 'batches' && recordSource === 'projects' && !publicMode ? <AgentWorkbench initialTab="results" onImported={openAnswerBatch}/> : panel === 'batches' && recordSource === 'answers' && !publicMode ? <AnswerRecords selectedBatch={answerBatch} onBatch={openAnswerBatch} onDataset={() => { setDatasetLibrary('legacy');navigate('datasets');const p=new URLSearchParams(location.search);p.set('library','legacy');history.replaceState(null,'',`${location.pathname}?${p}`);void refresh() }}/> : !['overview','evaluate','settings'].includes(panel) && <Workspace panel={panel} batches={batches} activeBatch={activeBatch} issueDimension={issueDimension} criticalOnly={criticalOnly} onNavigate={navigate} onBatch={selectBatch} onIssues={openIssues} onOpen={(id, tab = 'replay') => { setDetailId(id); setDetailTab(tab) }} onRefresh={refresh} onPrepare={(datasetId, caseIds) => { setSelection({ datasetId, caseIds }); navigate('evaluate') }}/>}

        {panel === 'evaluate' && (!publicMode ? <EvaluationStart key={startKey} initialSelection={selection} onCreated={id => { setRecordSource('native'); setActiveBatch(id); navigate('batches', id); void refresh() }} onImported={openAnswerBatch}/> : <LocalEvaluations embeddedPage="new" initialSelection={selection} onCreated={id => { setActiveBatch(id); navigate('batches', id); void refresh() }}/>) }
        {panel === 'settings' && <LocalEvaluations embeddedPage="connection"/>}
    </WorkspaceFrame>

    <AnimatePresence>{detailId && <MotionDialog key="run-detail" label="评测详情" backdrop="drawer-backdrop" panel="drawer" drawer onClose={() => setDetailId('')}><div className="drawer-header"><div><div className="eyebrow">评测详情</div><h2>{detail?.case?.title || '加载记录...'}</h2><p>{detail?.case_id} · {short(detail?.run_id)}</p></div><button className="icon-button" aria-label="关闭详情" onClick={() => setDetailId('')}><X size={20}/></button></div>{detail && <><div className="drawer-summary"><Badge value={detail.status}/><span><Activity size={15}/> {detail.execution_mode === 'recorded' ? `已有记录 · 本次业务调用 0 · 历史证据 ${detail.model_calls}` : personalMode ? '模型用量未核验' : `模型调用 ${detail.model_calls}`} </span><span><Clock3 size={15}/> {fmt(detail.started_at)}</span></div><details className="technical-ids"><summary>技术标识</summary><div className="id-grid"><div><small>平台 Trace ID</small><code>{detail.trace_id}</code></div><div><small>业务 Run ID</small><code>{detail.business_run_id || detail.business_execution_id || '未取得'}</code></div></div></details><div className="tabs">{([['replay','输入与回答'],['timeline','执行时间线'],['diagnosis','结果与排查'],['output','原始输出'],['artifacts','产物与复核']] as const).map(([key,label]) => <button key={key} className={detailTab === key ? 'active' : ''} onClick={() => setDetailTab(key)}>{label}</button>)}{!publicMode && !personalMode && <button className={detailTab === 'actions' ? 'active' : ''} onClick={() => setDetailTab('actions')}>运行与同步</button>}</div><ContentTransition className="drawer-body" identity={`${detailId}:${detailTab}`} variant={detailTab === 'replay' ? 'conversation' : 'page'}>
      {detailTab === 'diagnosis' && <><EvidenceWorkbench key={detail.run_id} run={detail} writable={!publicMode && !personalMode}/><details className="ev-disclosure"><summary>查看全部检查依据</summary><p className="dim">保留每项判断与验证建议，按需展开查看。</p>{diagnosis?.findings?.length ? diagnosis.findings.map((f,i) => <div className={`finding ${f.status}`} key={i}><div className="finding-top"><div className="finding-icon">{f.status === 'pass' ? <CheckCircle2 size={18}/> : f.status === 'fail' ? <AlertTriangle size={18}/> : <CircleDashed size={18}/>}</div><strong>{dimensionLabel[f.dimension] || f.dimension}</strong><Badge value={f.status} critical={f.critical}/></div><p>{f.rationale}</p>{f.hypothesis && <div className="finding-extra"><strong>疑似原因</strong> {f.hypothesis}</div>}{f.alternative && <div className="finding-extra"><strong>尚未排除</strong> {f.alternative}</div>}{f.controlled_replay && <div className="finding-extra"><strong>受控重跑</strong> {f.controlled_replay}</div>}<div className="evidence">证据：{f.evidence.join(' · ') || '待补充'}</div></div>) : <div className="empty compact">运行结束后生成检查结果</div>}</details>{comparison && <div className="comparison"><div className="section-title"><h3><GitCompareArrows size={16}/> 与上次运行比较</h3><small>{comparison.comparable ? '同一冻结用例' : comparison.reason}</small></div>{comparison.comparable && <div className="compare-values"><div><small>上次</small><Badge value={comparison.left.run.status}/><strong>{comparison.left.run.model_calls} 次模型调用</strong></div><ArrowRight size={16}/><div><small>本次</small><Badge value={comparison.right.run.status}/><strong>{comparison.right.run.model_calls} 次模型调用</strong></div></div>}</div>}<div className="drawer-actions">{['failed','timed_out','blocked','completed','cancelled'].includes(detail.status) && <button className="outline" disabled={publicMode || busy} title={localOnlyTitle} onClick={retry}><RefreshCw size={15}/> 新建重跑记录</button>}{detail.status === 'queued' && <button className="outline danger" disabled={publicMode || busy} title={localOnlyTitle} onClick={cancel}>取消排队</button>}</div></>}
      {detailTab === 'actions' && <ResultOperations single runIds={[detail.run_id]} onUpdated={() => void refresh()}/>}
      {detailTab === 'timeline' && <ProductTimeline run={detail}/>}
      {detailTab === 'replay' && <RunReplay run={detail} onEvidence={setDetailTab}/>}
      {detailTab === 'output' && <><div className="section-title"><h3>真实业务输出</h3><small>来自业务入口与持久运行记录</small></div><pre className="json-box">{json(detail.output || {})}</pre><div className="section-title"><h3>模型用量证据</h3><small>无业务用量时不计入真实模型完成数</small></div><pre className="json-box">{json(detail.model_evidence || {})}</pre><div className="section-title"><h3>代码版本指纹</h3></div><pre className="json-box">{json(detail.version || {})}</pre></>}
      {detailTab === 'artifacts' && <><div className="section-title"><h3>下载产物</h3><small>真实文件已保存并检查可打开性</small></div>{detail.artifacts?.length ? detail.artifacts.map(a => <a className="artifact-card" key={a.artifact_id} href={`/api/runs/${detail.run_id}/artifacts/${a.artifact_id}`}><FileText size={21}/><div><strong>{a.filename}</strong><small>{a.byte_size} 字节 · SHA-256 {short(a.sha256)} · 可打开：{String(a.checks.opened)}</small></div><Download size={16}/></a>) : <div className="empty compact">无文件产物</div>}<div className="section-title spaced"><h3>人工复核</h3><small>医生临床验证与工程评分分开记录</small></div><div className="review-form"><input placeholder="复核人姓名或标识" value={reviewer} onChange={e => setReviewer(e.target.value)}/><textarea placeholder="写明观察依据与结论" value={reviewText} onChange={e => setReviewText(e.target.value)}/><div><button className="outline" disabled={publicMode || !reviewer || !reviewText || busy} title={localOnlyTitle} onClick={() => review('pass')}>记录通过</button><button className="outline danger" disabled={publicMode || !reviewer || !reviewText || busy} title={localOnlyTitle} onClick={() => review('fail')}>记录失败</button><button className="plain" disabled={publicMode || !reviewer || !reviewText || busy} title={localOnlyTitle} onClick={() => review('unjudged')}>暂无法判断</button></div></div>{detail.verdicts?.filter(v => v.evaluator === 'human').map(v => <div className="human-review" key={v.verdict_id}><Badge value={v.result}/><strong>{v.reviewer}</strong><span>{v.rationale}</span></div>)}</>}
    </ContentTransition></>}</MotionDialog>}</AnimatePresence>
  </>
}

export default App
