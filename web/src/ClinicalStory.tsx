import { useEffect, useState } from 'react'
import { ArrowRight, ArrowUpRight, ChevronRight } from 'lucide-react'
import { readJson } from './publicSnapshot'
import './clinical-story.css'

const runId = 'run_c0a39b1970e24bce9dc55e0dbf83e043'
const consoleLink = (tab = 'replay') => `?space=history&view=batches&run=${runId}&tab=${tab}`
const steps = ['问题与标准', '实际运行', '逐轮证据', '失败定位', '修正与验证']
type RecordData = { run_id: string; trace_id: string; business_run_id?: string; model_calls: number; case: { turns: { message: string }[] }; output: { conversation_turns: Record<string, any>[] }; verdicts: { dimension: string; result: string; rationale: string; evidence: string[] }[]; events: { node: string; payload: any }[] }

export default function ClinicalStory() {
  const [step, setStep] = useState(0), [data, setData] = useState<RecordData | null>(null), [error, setError] = useState('')
  useEffect(() => { fetch(`/apps/evaluation/runs/${runId}.json`).then(r => readJson<RecordData>(r, '案例证据')).then(setData).catch(e => setError(e.message)) }, [])
  const finding = data?.verdicts.find(v => v.dimension === 'context_correction' && v.result === 'fail')
  const diagnosis = data?.events.filter(e => e.node === 'diagnosis').slice(-1)[0]?.payload
  return <div className="story-shell">
    <header className="story-nav"><a href="/" target="_top">丁泓力 <span>AI Agent 产品经理</span></a><nav><a href="https://github.com/DominicHongliDing" target="_blank" rel="noreferrer">GitHub <ArrowUpRight size={14}/></a><a href="?space=history&view=batches">全部历史</a><a href="?space=mine&view=agents">用自己的 Key 评测</a></nav></header>
    <main className="story-main">
      <div className="story-eyebrow">AGENT EVO / CLINICAL CASE STUDY</div>
      <h1>答案生成了，<br/>任务真的完成了吗？</h1>
      <p className="story-intro">从一个真实保存的 Clinical 工程失败出发，看我如何定义测试标准、追踪执行证据，并把问题转成可验证的改进。</p>
      <div className="story-facts"><div><strong>50 条</strong><span>Clinical 主批次合成用例</span></div><div><strong>177 次</strong><span>主批次历史模型调用</span></div><div><strong>17 条</strong><span>主批次含质量失败</span></div><div><strong>2 轮</strong><span>下方独立会话案例</span></div></div>
      <p className="story-scope">主批次与下方独立多轮记录分别计数。工程评测，医生临床验证尚未开展。浏览已有记录不会调用模型。</p>
      <section className="story-case"><div className="story-case-heading"><div><span className="story-eyebrow">一个例子，贯穿完整链路</span><h2>用户把“两周”更正为“三天”</h2></div><span className="story-status">上下文更正失败 · 模型辅助，待人工复核</span></div>
        <div className="story-steps" role="tablist" aria-label="案例阅读步骤">{steps.map((label,i) => <button key={label} id={`story-tab-${i}`} role="tab" aria-selected={step===i} aria-controls="story-panel" tabIndex={step===i ? 0 : -1} onClick={() => setStep(i)} onKeyDown={e => {if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();const n=(i+(e.key==='ArrowRight'?1:4))%5;setStep(n);document.getElementById(`story-tab-${n}`)?.focus()}}}><span>0{i+1}</span>{label}</button>)}</div>
        <div className="story-panel" id="story-panel" role="tabpanel" aria-labelledby={`story-tab-${step}`}>
          {error ? <p role="alert">{error}<a href={consoleLink()}>打开完整记录</a></p> : !data ? <p role="status">正在读取已保存的案例证据…</p> : <>
          {step===0 && <div className="story-columns"><article><h3>要解决的用户问题</h3><p>在连续对话中，用户需要更正之前的病例事实，并让下一轮任务采用新事实。单轮回答完整，仍可能漏掉跨轮任务。</p><blockquote>{data.case.turns[0].message}</blockquote><blockquote>{data.case.turns[1].message}</blockquote></article><article><h3>先定义“完成”</h3><ul><li>沿用同一业务会话，保留两轮输入与完整回答。</li><li>第二轮应采用“三天”，不继续沿用“两周”。</li><li>应响应“总结目前问题”的任务；信息不足可以说明边界，但需要体现已接收更正。</li><li>会话关联、回答完整性、语义更正、安全复核分开判断。</li></ul><p className="story-note">以上是本案例的产品验收解释；不作为医生审核金标。</p></article></div>}
          {step===1 && <><h3>执行完成，语义任务仍失败</h3><div className="story-verdicts">{data.verdicts.filter(v => ['recorded_answer','context_session','context_correction','critical_safety'].includes(v.dimension)).map((v,i) => <article key={i}><span className={`story-result ${v.result}`}>{({pass:'通过',fail:'失败',unjudged:'待判断'} as Record<string,string>)[v.result] || v.result}</span><strong>{({recorded_answer:'回答完整性',context_session:'会话关联',context_correction:'上下文更正',critical_safety:'关键安全'} as Record<string,string>)[v.dimension]}</strong><p>{v.rationale}</p></article>)}</div><p className="story-note">“通过”仅对应当前检查维度，不能合并为整体质量或临床效果。</p></>}
          {step===2 && <><h3>先看原文，再解释问题</h3><div className="story-transcript">{finding?.evidence.map((text,i) => <blockquote key={i}><span>证据 {i+1}</span><p>{text}</p></blockquote>)}</div><a className="story-link" href={consoleLink()}>打开完整逐轮回放与节点记录 <ArrowRight size={16}/></a></>}
          {step===3 && <div className="story-columns"><article><h3>已经观察到的失败</h3><p>{finding?.rationale}</p><h3>不能直接下结论的部分</h3><p>重复澄清话术是输出层证据。它不能单独证明是路由、上下文传递还是回答策略造成的；需要结合节点输入输出排查。</p></article><article><h3>已有诊断记录</h3><details><summary>展开疑似原因与原始诊断</summary><pre>{JSON.stringify(diagnosis || {status:'证据不足'},null,2)}</pre></details><a className="story-link" href={consoleLink('diagnosis')}>查看完整诊断 <ArrowRight size={16}/></a></article></div>}
          {step===4 && <div className="story-columns"><article><h3>下一次改动怎样验证</h3><ol><li>固定两轮输入、模型与知识快照，保留当前失败记录。</li><li>核对更正是否进入第二轮上下文及任务路由。</li><li>按定位结果调整更正传递或澄清策略，创建新 run 对照。</li><li>检查“三天”保留、总结响应及风险边界，再扩大回归集。</li></ol></article><article><span className="story-status">验证方案 · 尚未展示修复后运行</span><h3>用证据决定是否修好</h3><p>本案例只展示已有失败与后续验证方法。没有修复后的受控重跑记录，不能宣称该问题已经解决。</p><p>Clinical 其他模块的历史路由与检索对照属于独立工程集，也不能替代本例验证。</p></article></div>}
          <div className="story-case-footer"><code>{data.run_id}</code>{step<4 && <button onClick={()=>setStep(step+1)}>下一步：{steps[step+1]} <ChevronRight size={16}/></button>}</div>
          </>}
        </div>
      </section>
      <section className="story-method"><h2>我的产品决策</h2><div className="story-columns"><article><h3>把质量拆成可行动的判断</h3><p>规则检查负责确定性条件，模型评审辅助判断跨轮语义，人工复核处理金标与风险。每项判定保留依据；安全待判断不会被平均分抵消。</p></article><article><h3>让每个结论可以回到证据</h3><p>用例、批次、trace、原始输出与版本快照保持关联。Runner 与 SQLite 保存本地完整证据，访客业务版本另标用量未核验。</p></article></div><a className="story-link" href="?space=history&view=batches">浏览 50 条主批次和独立多轮记录 <ArrowRight size={16}/></a></section>
      <footer className="story-footer">FastAPI + SQLite Runner · React · 合成工程场景 <a href="?space=mine&view=agents">开始自己的评测 <ArrowUpRight size={14}/></a></footer>
    </main>
  </div>
}
