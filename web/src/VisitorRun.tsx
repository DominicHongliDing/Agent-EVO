import {useEffect,useState} from 'react'
import {Play} from 'lucide-react'
import {connectionSummary} from './personalWorkspace'
import {api} from './api'
import PersonalControls from './PersonalControls'
type Row=Record<string,any>
export default function VisitorRun({initialSelection,onCreated}:{initialSelection?:{datasetId:string;caseIds:string[]};onCreated:(id:string)=>void}){
  const [sets,setSets]=useState<Row[]>([]),[cases,setCases]=useState<Row[]>([]),[dataset,setDataset]=useState(initialSelection?.datasetId||''),[ids,setIds]=useState(initialSelection?.caseIds||[]),[name,setName]=useState('Clinical 评测'),[error,setError]=useState(''),[busy,setBusy]=useState(false),[ready,setReady]=useState(!!connectionSummary())
  useEffect(()=>{Promise.all([api<{items:Row[]}>('/datasets'),api<{items:Row[]}>('/cases')]).then(([d,c])=>{setSets(d.items.filter(d=>d.profile==='clinical'));setCases(c.items);setDataset(old=>old||d.items.find(d=>d.profile==='clinical')?.dataset_id||'')}).catch(e=>setError(e.message));const timer=setInterval(()=>setReady(!!connectionSummary()),500);return()=>clearInterval(timer)},[])
  const visible=cases.filter(c=>c.dataset_id===dataset)
  return <section className="visitor-task">
    <div className="page-heading"><div><h1>用测试集运行 Clinical</h1><p>选择问题，取得新的真实回复，再查看逐轮记录。</p></div></div>
    <PersonalControls/>
    <div className="visitor-setup"><label>测试集<select aria-label="运行测试集" value={dataset} onChange={e=>{setDataset(e.target.value);setIds([])}}>{sets.map(d=><option key={d.dataset_id} value={d.dataset_id}>{d.name} · {d.version}</option>)}</select></label><label>批次名称<input value={name} onChange={e=>setName(e.target.value)} maxLength={120}/></label></div>
    <section className="card visitor-cases"><header><label className="ai-check"><input type="checkbox" checked={!!visible.length&&visible.slice(0,100).every(c=>ids.includes(c.case_id))} onChange={e=>setIds(e.target.checked?visible.slice(0,100).map(c=>c.case_id):[])}/>选择全部（最多 100 条）</label><span>{visible.length} 条用例 · 已选 {ids.length} 条</span></header><div className="visitor-case-list" role="region" aria-label="选择评测问题" tabIndex={0}>{visible.map((c,i)=><label key={c.case_id} className="ai-check"><input type="checkbox" aria-label={`选择问题 ${i+1}`} checked={ids.includes(c.case_id)} disabled={!ids.includes(c.case_id)&&ids.length>=100} onChange={e=>setIds(e.target.checked?[...ids,c.case_id]:ids.filter(id=>id!==c.case_id))}/><span><strong>{c.message}</strong><small>{c.turns?.length||1} 轮对话</small>{c.turns?.length>1&&<details onClick={e=>e.stopPropagation()}><summary>查看各轮问题</summary>{c.turns.map((t:Row,n:number)=><p key={n}>第 {n+1} 轮：{t.message}</p>)}</details>}</span></label>)}{!visible.length&&<div className="empty">暂无可用问题，请先在“测试集”中上传 Clinical 题库。</div>}</div></section>
    {error&&<div role="alert" className="error-banner">{error}</div>}
    <footer className="task-footer"><div><strong>已选 {ids.length} 条</strong><small>{ready?'模型已连接。运行时请保持页面打开。':'先选择问题，配置 API Key 后即可运行。'}</small></div><button className="primary" disabled={busy||!ids.length||!ready} onClick={async()=>{setBusy(true);setError('');try{const b=await api<Row>('/batches',{method:'POST',body:JSON.stringify({agent_id:'agent_clinical',dataset_id:dataset,case_ids:ids,label:name})});onCreated(b.batch_id)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}><Play size={15}/>运行所选 {ids.length} 条</button></footer>
  </section>
}
