type Row=Record<string,any>
const labels:Record<string,string>={policy_lookup:'查找业务规则',context_assembly:'整理对话上下文',model_answer:'生成本轮回答',retrieval:'检索参考材料',tool_call:'调用业务工具'}
export default function ExecutionEvidence({turn}:{turn:Row}){
 const steps=Array.isArray(turn.steps)?turn.steps:[]
 return <section className="execution-evidence" aria-label="本轮执行步骤"><h3>回答是怎么产生的</h3>{steps.length?<ol>{steps.map((step:Row,i:number)=><li key={i}><strong>{labels[step.node]||step.name||step.node||`执行步骤 ${i+1}`}</strong>{typeof step.output==='string'&&<p>{step.output}</p>}{typeof step.history_messages==='number'&&<p>带入了 {step.history_messages} 条历史消息。</p>}{step.model&&<p>使用模型：{step.model}{Number.isFinite(step.latency_ms)?` · ${(step.latency_ms/1000).toFixed(1)} 秒`:''}</p>}</li>)}</ol>:<p>这份记录只上报了回答，暂时无法判断中间哪一步出错。</p>}<small>以下步骤由连接器上报，平台保留原始证据，不自动确认根因。</small><details><summary>查看原始步骤与用量</summary><pre>{JSON.stringify({steps:turn.steps,usage:turn.usage,versions:turn.versions},null,2)}</pre></details></section>
}
