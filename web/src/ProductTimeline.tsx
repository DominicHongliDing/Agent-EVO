import type { ReplayRun, ReplayEvent } from './replayPresentation'
import { buildTimeline, durationText, rowFor, stepFacts } from './productTimelinePresentation'
import type { TimelineStep } from './productTimelinePresentation'
import './product-timeline.css'

function Facts({ rows }: { rows: [string, string][] }) {
  return <dl className="et-facts">{rows.map(([label, value], i) => <div key={i}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

function RawEvents({ events }: { events: ReplayEvent[] }) {
  return <details className="et-raw">
    <summary>原始执行记录<span>{events.length} 条</span></summary>
    <div>{events.map(event => <section key={event.seq}>
      <p className="et-record-label">事件 #{event.seq} · {event.node} · {event.kind}</p>
      <pre tabIndex={0} aria-label={`事件 ${event.seq} 的原始 JSON`}>{JSON.stringify(event, null, 2)}</pre>
    </section>)}</div>
  </details>
}

function Action({ row }: { row: TimelineStep }) {
  const { input, output, errors } = stepFacts(row)
  const time = Date.parse(row.time)
  return <details className={`et-action ${row.status.tone}`}>
    <summary>
      <span className="et-dot" aria-hidden="true"/>
      <span className="et-description"><strong>{row.title}</strong><span>{row.description}</span></span>
      <span className="et-meta"><span className="et-status">{row.status.label}</span>{row.duration !== null && <span className="et-duration">{durationText(row.duration)}</span>}</span>
      <span className="et-chevron" aria-hidden="true">⌄</span>
    </summary>
    <div className="et-detail">
      <div className="et-detail-heading"><h4>步骤详情</h4>{Number.isFinite(time) && <time dateTime={row.time}>{new Date(time).toLocaleString('zh-CN', { hour12: false })}</time>}</div>
      <section><h5>这一步用了什么信息</h5>{input.length ? <Facts rows={input}/> : <p className="et-empty">记录中没有单独保存这一步的输入内容。</p>}</section>
      <section><h5>做了什么，得到了什么</h5><p className="et-result">{row.description}</p>{output.length ? <Facts rows={output}/> : <p className="et-empty">没有更多已保存的结果字段。</p>}</section>
      {errors.length > 0 && <section className="et-error"><h5>异常与提示</h5><Facts rows={errors}/></section>}
      {row.duration === null && <p className="et-empty">此步骤未记录独立耗时。</p>}
      <RawEvents events={row.sources}/>
    </div>
  </details>
}

export default function ProductTimeline({ run }: { run: ReplayRun }) {
  const model = buildTimeline(run)
  return <div className="evo-readable-timeline">
    <div className="et-intro"><strong>先看做了什么，再看具体依据</strong><p>点击任一步骤查看输入与结果；需要核查时，再展开原始执行记录。</p></div>
    {model.sections.map(turn => <section className="et-turn" key={turn.number}>
      {model.sections.length > 1 && <h3>第 {turn.number} 轮</h3>}
      <div className="et-input"><span className="et-input-label">用户提出问题</span><p>{turn.message || '这条记录没有保存用户输入。'}</p></div>
      {turn.steps.length ? <div className="et-steps">{turn.steps.map(row => <Action key={row.key} row={row}/>)}</div> : <p className="et-empty">没有保存此轮内部步骤，无法还原具体处理过程。</p>}
    </section>)}
    {model.unassigned > 0 && <p className="et-empty">{model.unassigned} 条内部记录未标明所属轮次，可在下方完整记录中查看。</p>}
    <details className="et-audit">
      <summary>评测准备与完整记录<span>{model.events.length} 条原始事件</span></summary>
      <p className="et-empty">包括任务安排、服务连接、业务处理和评测汇总。“当时开始”表示记录发生的时刻。</p>
      {model.events.length ? model.events.map(event => <Action key={event.seq} row={rowFor(event, null, run)}/>) : <p className="et-empty">尚无事件记录。</p>}
    </details>
  </div>
}
