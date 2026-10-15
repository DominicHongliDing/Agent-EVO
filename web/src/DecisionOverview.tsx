import { decisionSummary } from './decisionCore.mjs'
import './decisions.css'
type Row=Record<string,any>
export default function DecisionOverview({snapshot,onOpen}:{snapshot:Row;onOpen:(id:string)=>void}){
  const d=decisionSummary(snapshot)
  return <section className="decision-overview" aria-label="本次评测的下一步">
    <div className="decision-heading"><span className="eyebrow">下一步判断</span><h3>{d.title}</h3><p>{d.description}</p></div>
    <div className="decision-distribution" role="img" aria-label={`完整评分达标 ${d.counts.pass} 条，未达标 ${d.counts.fail} 条，尚不能完整判断 ${d.counts.unknown} 条`}>
      {(['pass','fail','unknown'] as const).map(k=><span key={k} className={k} style={{width:(d.total?100*d.counts[k]/d.total:0)+'%'}}/>)}</div>
    <div className="decision-legend"><span>已判断达标 {d.counts.pass}</span><span>已判断未达标 {d.counts.fail}</span><span>尚不能完整判断 {d.counts.unknown}</span></div>
    {d.findings.slice(0,3).map((f:Row)=><article className="decision-finding" key={f.key}><div><strong>{f.priority===0?'优先复核':'待审核'} · {f.title}</strong><p>{f.reason}</p><small>可能的用户影响：{f.impact}</small><p className="decision-action">下一步：{f.action}</p></div><button className="outline" onClick={()=>onOpen(f.record_id)}>查看证据</button></article>)}
    <p className="report-muted">以上根据已保存的判决整理。影响与原因需业务复核；不据此自动批准上线。</p>
  </section>
}
