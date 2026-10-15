import { useEffect, useState } from 'react'
import { api } from './api'
import './evidence-workbench.css'
type Group = { case_id:string;title:string;planned:number;judged:number;passed:number;complete:boolean;all_passed:boolean;runs:{run_id:string;repetition_index:number;quality:string;execution:string}[] }
type Report = { planned:number;judged:number;macro_pass_rate:number|null;complete_cases:number;all_passed_cases:number;case_count:number;covered_cases:number;repetitions:number;note:string;groups:Group[] }
export default function StabilityPanel({ batchId, finished, onOpen }: {batchId:string;finished:number;onOpen:(id:string)=>void}) {
  const [data,setData]=useState<Report>(),[error,setError]=useState('')
  useEffect(()=>{let active=true;setData(undefined);setError('');api<Report>(`/batches/${batchId}/stability`).then(r=>{if(active)setData(r)}).catch(e=>{if(active)setError(e.message)});return()=>{active=false}},[batchId,finished])
  if(error)return <p role="alert">稳定性统计暂不可用：{error}</p>
  if(!data)return <p className="dim">读取逐题结果…</p>
  return <section className="ev-workbench" style={{padding:'20px 24px'}} aria-label="逐题稳定性"><div className="ev-status"><div><small>按题等权通过率</small><strong>{data.macro_pass_rate == null ? '待判断' : `${(data.macro_pass_rate*100).toFixed(1)}%`}</strong><small>{data.covered_cases}/{data.case_count} 题有有效判断</small></div><div><small>有效判分 / 计划执行</small><strong>{data.judged}/{data.planned}</strong><small>运行失败、待判单独保留</small></div><div><small>{data.repetitions} 次全部通过</small><strong>{data.all_passed_cases}/{data.complete_cases} 题</strong><small>{data.complete_cases}/{data.case_count} 题已完整判分</small></div></div><p className="ev-muted">{data.note}</p><details><summary>按问题查看每一次运行 · {data.case_count} 题</summary>{data.groups.map(g=><details key={g.case_id} className="ev-disclosure"><summary>{g.title} <span>{g.passed}/{g.planned} 次通过 · {g.complete?'判分齐全':'仍有未完成判断'}</span></summary><div className="ev-actions">{g.runs.map(r=><button key={r.run_id} onClick={()=>onOpen(r.run_id)}>第 {r.repetition_index} 次 · {r.quality==='pass'?'通过':r.quality==='fail'?'发现问题':'待判断'}</button>)}</div></details>)}</details></section>
}
