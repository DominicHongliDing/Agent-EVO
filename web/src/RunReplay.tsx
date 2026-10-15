import Markdown from 'react-markdown'
import { MotionDisclosure } from './Motion'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, Bot, CheckCircle2, ChevronDown, Clock3, Download, FileText, MessageSquare, Search, ShieldCheck, UserRound, Workflow } from 'lucide-react'
import { answerParts, record, replaySources, replaySteps, stepStatus, stepTone, text } from './replayPresentation'
import type { ReplayRun } from './replayPresentation'
import { personalMode } from './publicSnapshot'

const phases = [
  { title: '理解问题', icon: MessageSquare }, { title: '查找与核对资料', icon: Search },
  { title: '执行与生成', icon: Workflow }, { title: '检查与交付', icon: ShieldCheck },
]
function ReadableText({ content }: { content: string }) {
  return <div className="replay-markdown"><Markdown remarkPlugins={[remarkGfm]} disallowedElements={['img']}
    components={{ a: ({ children, href }) => href && /^https?:\/\//i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span> }}>{content}</Markdown></div>
}
const time = (value: string) => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : ''
const byteSize = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`

export default function RunReplay({ run, onEvidence }: { run: ReplayRun; onEvidence: (tab: 'diagnosis' | 'timeline' | 'output') => void }) {
  if (run.case?.turns?.length) {
    const rows = Array.isArray(run.output?.conversation_turns) ? run.output.conversation_turns.map(record) : []
    const completed = rows.filter(row => row.status === 'completed').length
    const judgeCalls = run.events?.filter(event => event.node === 'context.semantic.usage') || []
    const judgeStarted = run.events?.some(event => event.node === 'context.semantic.start')
    const judgeResult = run.events?.find(event => event.node === 'context.semantic.result')
    return <div className="conversation-replay" aria-label="多轮真实对话"><div className="replay-heading"><div><h3>多轮对话回放</h3><p>{completed} / {run.case.turns.length} 轮已完成 · 每轮沿用同一业务会话</p></div><button className="text-button" onClick={() => onEvidence('diagnosis')}>查看上下文评测</button></div>
      <div className="conversation-evaluation-note">{personalMode ? '逐轮词项检查已单列；独立语义评审未执行，需人工复核。模型用量未核验。' : <>{run.execution_mode === "recorded" && "评测已有记录 · 本次业务调用 0 次 · "}语义评审：{judgeResult ? (judgeResult.status === "completed" ? "已完成，待人工复核" : "待判断") : judgeStarted ? "评审中" : completed < run.case.turns.length ? "等待对话完成" : "等待评审结果"} · 调用 {judgeCalls.length} 次，单独记录。</>}</div>
      {run.case.turns.map((turn, index) => {
        const row = rows.find(item => item.turn_index === index + 1) || {}
        const status = text(row.status) || 'not_started'
        const findings = run.verdicts?.filter(verdict => verdict.dimension.startsWith('context_') && verdict.rationale.startsWith(`第 ${index + 1} 轮`)) || []
        const contextFailures = findings.filter(finding => finding.result === 'fail').length
        const current: ReplayRun = { ...run, output: record(row.output), status: status === 'not_started' ? 'queued' : status,
          error_code: text(row.error_code), case: { ...run.case!, message: turn.message, turns: undefined, materials: index === 0 ? run.case?.materials : undefined },
          events: run.events?.filter(event => record(event.payload).turn_index === index + 1), verdicts: findings,
          artifacts: undefined }
        return <MotionDisclosure className={`conversation-turn ${status} ${contextFailures ? 'context-warning' : ''}`} key={index} defaultOpen={status === 'running' || status === 'failed' || index === completed - 1} summary={<><strong>第 {index + 1} 轮</strong><span>{turn.message}</span><small>{status === 'not_started' ? '尚未执行' : stepStatus(status)}{contextFailures > 0 && <b> · {contextFailures} 项上下文需关注</b>}</small><ChevronDown size={16}/></>}>
          <div className="conversation-turn-meta">{personalMode ? '模型用量未核验' : `${run.execution_mode === "recorded" ? "历史模型证据" : "业务模型调用"} ${Number(row.model_calls || 0)} 次`}{row.answer_coverage === "saved_summary" ? " · 仅保存摘要，完整回答待补证" : ""}{row.latency_ms ? ` · 耗时 ${(Number(row.latency_ms) / 1000).toFixed(1)} 秒` : ""} · 会话 {personalMode ? text(row.conversation_id).slice(0,16) : text(row.conversation_id) || '待建立'} · 业务记录 {text(row.business_run_id) || text(row.business_execution_id) || (personalMode ? '接口未提供' : '待返回')}</div>
          <RunReplay run={current} onEvidence={onEvidence}/>
          {findings.length > 0 && <div className="conversation-checks">{findings.map((finding, key) => <div className={finding.result} key={key}><strong>{finding.result === 'pass' ? '通过' : finding.result === 'fail' ? '需关注' : '待判断'}</strong><span>{finding.rationale}</span></div>)}</div>}
        </MotionDisclosure>
      })}
      {!!run.artifacts?.length && <section className="replay-delivery"><h4>本次对话生成的文件</h4>{run.artifacts.map(artifact => <a key={artifact.artifact_id} className="replay-file" href={`/api/runs/${run.run_id}/artifacts/${artifact.artifact_id}`}><FileText size={21}/><div><strong>{artifact.filename}</strong><small>{byteSize(artifact.byte_size)} · {artifact.checks.opened === true ? "已验证可打开" : "可打开性未验证"}</small></div><Download size={17}/></a>)}</section>}
      <button className="replay-raw-link" onClick={() => onEvidence('output')}>查看完整多轮原始输出</button>
    </div>
  }
  const steps = replaySteps(run), parts = answerParts(run), sources = replaySources(run)
  const live = ['queued', 'running'].includes(run.status)
  const failed = ['failed', 'timed_out', 'blocked', 'cancelled'].includes(run.status)
  const findings = run.verdicts?.filter(v => v.result === 'fail') || []
  const critical = findings.filter(v => v.critical)
  const confirmation = record(record(run.output?.result).answer).clinician_confirmation_items
  const fixtures = (run.case?.fixtures || []).map(value => {
    const fixture = record(value)
    const name = text(fixture.filename) || text(fixture.name) || text(fixture.path) || text(value)
    return name.split(/[\\/]/).pop() || ''
  }).filter(Boolean)

  return <div className="replay" aria-label="真实业务交互回放">
    <div className="replay-heading"><div><h3>交互回放</h3><p>查看本次实际输入、处理过程和答复</p></div><span className={`replay-live ${live ? 'is-live' : ''}`}><span/>{live ? '实时更新' : '已保存记录'}</span></div>
    <section className="replay-message user"><div className="replay-role"><span className="replay-avatar"><UserRound size={16}/></span><strong>我的输入</strong></div><div className="replay-user-text">{run.case?.message || '此记录未保存用户输入。'}</div>{fixtures.length > 0 && <div className="replay-attachments">{fixtures.map((name, i) => <span key={i}><FileText size={13}/>{name}</span>)}</div>}
      {run.case?.case_context_text && <details className="replay-context"><summary>本轮病例上下文 <ChevronDown size={14}/></summary><div className="replay-user-text">{run.case.case_context_text}</div></details>}
      {run.case?.materials?.map((material, i) => <details className="replay-context" key={i}><summary>输入材料 · {material.name} <ChevronDown size={14}/></summary><div className="replay-user-text">{material.text}</div></details>)}
    </section>

    <section className="replay-execution"><div className="replay-section-heading"><h4><Workflow size={15}/> 执行过程</h4><button onClick={() => onEvidence('timeline')}>查看节点证据</button></div>
      <div className="replay-phases">{phases.map((phase, index) => {
        const rows = steps.filter(step => step.phase === index)
        if (!rows.length) return null
        const last = rows[rows.length - 1]
        const attention = rows.filter(row => ['bad', 'warn'].includes(stepTone(row.status)))
        const tone = rows.some(row => stepTone(row.status) === 'bad') ? 'bad' : attention.length ? 'warn' : stepTone(last.status)
        const Icon = phase.icon
        return <details className={`replay-phase ${tone}`} key={phase.title}>
          <summary><span className="replay-phase-icon"><Icon size={16}/></span><div><strong>{phase.title}</strong><small>{rows.length} 个实际步骤{attention.length ? ` · ${attention.length} 个需关注` : ''}</small><p className="replay-phase-preview">{last.description}</p></div><ChevronDown size={15}/></summary>
          <ol className="replay-steps">{rows.map(step => <li key={step.key} className={stepTone(step.status)}><span className="replay-step-dot"/><div><div className="replay-step-heading"><strong>{step.title}</strong><span>{stepStatus(step.status)}</span></div><p>{step.description}</p><small>{time(step.time)} · 事件 #{step.seq}</small></div></li>)}</ol>
        </details>
      })}</div>
      {!steps.length && <div className="replay-wait"><Clock3 size={17}/>{run.status === 'queued' ? '请求正在排队，业务执行步骤尚未开始。' : live ? '正在等待业务入口返回执行步骤…' : '此记录未取得业务步骤，可查看节点证据确认原因。'}</div>}
      <small className="replay-process-note">展开阶段查看每一步；步骤状态来自业务记录。</small>
    </section>

    {(failed || findings.length > 0) && <div className={`replay-notice ${critical.length || failed ? 'bad' : 'warn'}`}><AlertTriangle size={17}/><div><strong>{failed ? '本次执行未正常完成' : critical.length ? `发现 ${critical.length} 项关键安全失败` : `评测发现 ${findings.length} 项问题`}</strong><p>{failed ? `已保留可取得的过程与输出${run.error_code ? `（${run.error_code}）` : ''}。` : '业务返回了结果，评测结论仍需结合诊断依据复核。'}</p>{critical.map((finding, i) => <p key={i}>{finding.rationale}</p>)}</div><button onClick={() => onEvidence('diagnosis')}>查看诊断</button></div>}

    <section className="replay-message assistant"><div className="replay-role"><span className="replay-avatar"><Bot size={17}/></span><strong>{run.agent_name || (run.case?.agent === 'clinical' ? 'Clinical' : run.case?.agent === 'unihr' ? 'UniHR' : 'Agent')} 的{live || failed ? '已保存输出' : '最终回答'}</strong>{parts.length > 0 && <span className="replay-answer-origin"><CheckCircle2 size={12}/> 业务原文</span>}</div>
      {parts.length ? parts.map((part, index) => <div key={index} className="replay-answer-part">{part.title && <h4>{part.title}</h4>}<ReadableText content={part.content}/></div>) : <div className="replay-wait"><Clock3 size={17}/>{live ? '回答尚未返回，处理步骤会持续更新。' : failed ? '未取得最终回答，请查看上方执行过程与故障诊断。' : '未找到可展示的回答正文，可查看原始输出。'}</div>}
      {Array.isArray(confirmation) && confirmation.length > 0 && <div className="replay-confirmation"><strong>医生确认事项</strong><ul>{confirmation.map((item, i) => typeof item === 'string' && <li key={i}>{item}</li>)}</ul></div>}
      {run.case?.agent === 'clinical' && <div className="replay-clinical-note">本记录为合成工程测试，尚未经过医生临床验证。</div>}
      <button className="replay-raw-link" onClick={() => onEvidence('output')}>查看完整原始输出</button>
    </section>

    {sources.length > 0 && <details className="replay-sources"><summary><FileText size={16}/><strong>本次引用的资料</strong><span>{sources.length} 条</span><ChevronDown size={15}/></summary><div>{sources.map(source => <article key={source.key}><span className="replay-reference">{source.reference}</span><div><h4>{source.title}</h4>{source.version && <small>{source.version}</small>}{source.excerpt && <p>{source.excerpt}</p>}</div></article>)}</div></details>}
    {!!run.artifacts?.length && <section className="replay-delivery"><div className="replay-section-heading"><h4><FileText size={15}/> 本次生成的文件</h4></div>{run.artifacts.map(artifact => <a key={artifact.artifact_id} className="replay-file" href={`/api/runs/${run.run_id}/artifacts/${artifact.artifact_id}`}><FileText size={21}/><div><strong>{artifact.filename}</strong><small>{byteSize(artifact.byte_size)} · {artifact.checks.opened === true ? '已验证可打开' : artifact.checks.opened === false ? '文件打开检查失败' : '可打开性未验证'}</small></div><Download size={17}/></a>)}</section>}
  </div>
}
