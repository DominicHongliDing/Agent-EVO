import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import RunReplay from './RunReplay'
import type { ReplayRun } from './replayPresentation'
import './style.css'
import './conversation.css'
import './public-replay.css'

type PublicRun = ReplayRun & { title: string; model_calls: number; verdicts: { dimension: string; result: string; rationale: string; critical: number }[] }
const dimensions: Record<string, string> = { context_correction: '信息更正', context_fact_retention: '事实保留', context_constraint: '约束延续', context_topic_return: '话题返回', context_isolation: '对象隔离', context_session: '会话关联', context_model_evidence: '逐轮模型证据', context_semantics: '上下文语义', recorded_answer: '回答完整性', critical_safety: '关键安全项', intent: '意图识别', retrieval: '材料召回', source_selection: '材料选择', live_model: '历史业务模型证据', recorded_model: '历史业务模型证据', business_execution: '业务完成状态' }

function PublicReplay() {
  const [runs, setRuns] = useState<PublicRun[]>([])
  const [selected, setSelected] = useState('')
  const [tab, setTab] = useState<'replay' | 'diagnosis' | 'timeline' | 'output'>('replay')
  const [error, setError] = useState('')
  useEffect(() => { fetch('/apps/evaluation/records.json').then(response => { if (!response.ok) throw new Error('记录暂时不可用'); return response.json() }).then(data => { setRuns(data.runs); setSelected(data.runs[0]?.run_id || '') }).catch(reason => setError(String(reason))) }, [])
  const run = runs.find(item => item.run_id === selected)
  const judgeCalls = run?.events?.filter(event => event.node === 'context.semantic.usage').length || 0
  const failed = run?.verdicts.filter(verdict => verdict.result === 'fail') || []
  return <div className="public-evo"><header className="public-evo-header"><a href="/">丁泓力 · AI Agent 产品经理</a><strong>Agent EVO · 逐轮评测</strong><span>公开合成记录</span></header><main className="public-evo-main"><aside className="public-evo-list"><h1>对话评测</h1><p>选择一段真实执行记录，查看问答、每轮判断及节点证据。</p>{runs.map(item => <button key={item.run_id} className={selected === item.run_id ? 'active' : ''} onClick={() => { setSelected(item.run_id); setTab('replay') }}><strong>{item.agent_name}</strong><span>{item.title}</span><small>{item.case?.turns?.length || 1} 轮 · {item.model_calls} 次历史调用</small></button>)}<div className="public-evo-note">这里展示已保存的合成记录。实时接入、测试集管理与真实重跑在本地平台运行。医疗结论仍需医生独立验证。</div></aside><section className="public-evo-record">{error && <p role="alert">{error}</p>}{!run && !error && <p>正在读取评测记录…</p>}{run && <><div className="public-evo-title"><div><small>已有记录评测</small><h2>{run.title}</h2></div><span className={`badge ${failed.length ? 'fail' : 'completed'}`}>{failed.length ? `${failed.length} 项需关注` : '查看逐项判断'}</span></div><div className="public-evo-metrics"><div><span>导入新增业务调用</span><strong>0</strong></div><div><span>历史模型调用证据</span><strong>{run.model_calls}</strong></div><div><span>独立模型评审</span><strong>{judgeCalls}</strong></div></div><div className="tabs">{([['replay','交互回放'],['diagnosis','逐轮诊断'],['timeline','节点时间线'],['output','原始输出']] as const).map(([key,label]) => <button key={key} onClick={() => setTab(key)} className={tab === key ? 'active' : ''}>{label}</button>)}</div><div className="public-evo-body">{tab === 'replay' && <RunReplay run={run} onEvidence={setTab}/>} {tab === 'diagnosis' && <>{run.verdicts.map((verdict,index) => <article className={`finding ${verdict.result}`} key={index}><div className="finding-top"><strong>{dimensions[verdict.dimension] || verdict.dimension}</strong><span className={`badge ${verdict.result}`}>{verdict.result === 'pass' ? '通过' : verdict.result === 'fail' ? '需关注' : '待判断'}{verdict.critical ? ' · 关键安全' : ''}</span></div><p>{verdict.rationale}</p></article>)}<p>自动归因有不确定性。请结合原文引用、节点证据和受控重跑复核。</p></>}{tab === 'timeline' && <>{run.events?.filter(event => event.kind === 'business_step' || event.kind === 'business_event').map(event => <details className="public-evo-event" key={event.seq}><summary>第 {String((event.payload as Record<string, unknown>)?.turn_index || '?')} 轮 · {event.node} · {event.status}</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>)}</>}{tab === 'output' && <><h3>真实业务输出与完整评测证据</h3><pre>{JSON.stringify(run, null, 2)}</pre></>}</div></>}</section></main></div>
}
createRoot(document.getElementById('root')!).render(<PublicReplay/> )
