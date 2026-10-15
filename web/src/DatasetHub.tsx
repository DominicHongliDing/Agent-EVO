import { useEffect, useState } from 'react'
import AgentWorkbench from './AgentWorkbench'
import { api } from './api'
import { workbenchApi } from './workbenchClient'
import './datasetHub.css'

type Row = Record<string, any>
export default function DatasetHub({onImported,onNative,onManage}:{onImported:(id:string)=>void;onNative:(id:string)=>void;onManage:()=>void}) {
  const [mode,setMode]=useState('library'),[editorOpened,setEditorOpened]=useState(false),[items,setItems]=useState<Row[]>([]),[query,setQuery]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true)
  const [selection,setSelection]=useState<Row>(),[revision,setRevision]=useState(0)
  useEffect(()=>{if(mode!=='library')return;let active=true;setLoading(true);setError('');(async()=>{
    const sources=await Promise.allSettled([api<Row>('/datasets'),workbenchApi('/projects')]);const rows:Row[]=[];const failures:string[]=[]
    if(sources[0].status==='fulfilled')rows.push(...sources[0].value.items.map((d:Row)=>({...d,id:d.dataset_id,kind:'native',count:d.case_count,origin:'已有测试集'})));else failures.push('已有测试集暂时未能读取')
    if(sources[1].status==='fulfilled'){
      const projects=sources[1].value.items as Row[]
      const results=await Promise.allSettled(projects.map(p=>workbenchApi('/projects/'+p.id+'/datasets')))
      results.forEach((r,i)=>{if(r.status==='fulfilled')rows.push(...r.value.items.map((d:Row)=>({...d,kind:'project',project:projects[i].id,origin:projects[i].name,count:d.cases.length})));else failures.push(projects[i].name+' 的测试集暂时未能读取')})
    }else failures.push('项目测试集暂时未能读取')
    if(active){setItems(rows.sort((a,b)=>Number(b.kind==='project')-Number(a.kind==='project')||String(b.created_at||'').localeCompare(String(a.created_at||''))));setError(failures.join('；'));setLoading(false)}
  })().catch(e=>{if(active){setError(e.message);setLoading(false)}});return()=>{active=false}},[mode,revision])
  function generate(next?:Row){setSelection(next);setEditorOpened(true);setMode('generate')}
  async function download(d:Row){try{const material=d.kind==='native'?{name:d.name,cases:(await api<Row>('/cases?dataset_id='+encodeURIComponent(d.id))).items}:{name:d.name,cases:d.cases,generation:d.generation,preparation:d.preparation};const url=URL.createObjectURL(new Blob([JSON.stringify(material,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=d.name+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(e){setError((e as Error).message)}}
  const visible=items.filter(d=>(d.name+' '+d.origin).toLowerCase().includes(query.toLowerCase()))
  return <section className="dataset-hub">
    <nav className="ai-source-tabs" aria-label="测试集管理"><button aria-pressed={mode==='generate'} onClick={()=>editorOpened?setMode('generate'):generate()}>AI 生成</button><button aria-pressed={mode==='library'} onClick={()=>setMode('library')}>测试集库</button></nav>
    <div className="hub-editor" hidden={mode!=='generate'}>{editorOpened&&<AgentWorkbench key={selection?selection.id+selection.action:'new'} context="datasets" initialProjectId={selection?.project} initialDatasetId={selection?.id} datasetAction={selection?.action} initialPrepareMode={selection?.mode} onImported={onImported} onDatasetSaved={()=>{setMode('library');setEditorOpened(false);setRevision(v=>v+1)}} onLibrary={()=>setMode('library')}/>}</div>{mode==='library'&&<>
      <header className="page-heading"><div><h1>测试集库</h1><p>生成、上传和示例问题都在这里。选一组问题，复用到下一次评测。</p></div><div className="heading-actions"><button className="outline" onClick={()=>generate({id:'upload',mode:'import'})}>上传测试集 / 下载样本</button><button className="primary" onClick={()=>generate()}>AI 生成测试集</button></div></header>
      <div className="library-toolbar"><input aria-label="搜索测试集" placeholder="搜索测试集或项目" value={query} onChange={e=>setQuery(e.target.value)}/><span>{visible.length} 个测试集</span><button className="text-button" onClick={onManage}>管理已有测试集</button></div>
      {error&&<p role="alert" className="error-banner">{error}<button onClick={()=>setRevision(v=>v+1)}>重试</button></p>}
      <div className="library-scroll card" role="region" aria-label="全部测试集" tabIndex={0}><table><thead><tr><th>测试集</th><th>所属项目 / 来源</th><th>问题数</th><th>操作</th></tr></thead><tbody>{visible.map(d=><tr key={d.kind+d.id}><td><strong>{d.name}</strong><small>{d.kind==='project'?'已保存版本 · '+d.cases.filter((c:Row)=>c.review_status==='confirmed').length+' 条已确认':d.version+' · '+(d.description||'已有问题与期望')}</small></td><td>{d.origin}</td><td>{d.count} 条</td><td><div className="library-actions"><button className="outline" onClick={()=>d.kind==='native'?onNative(d.id):generate({...d,action:'edit'})}>{d.kind==='project'?'查看 / 编辑副本':'查看问题'}</button>{d.kind==='project'&&<button className="text-button" onClick={()=>generate({...d,action:'run'})}>连接与运行</button>}<button className="text-button" onClick={()=>void download(d)}>下载</button></div></td></tr>)}</tbody></table>{loading&&<p role="status" className="empty">正在读取测试集…</p>}{!loading&&!visible.length&&<p className="empty">{query?'没有匹配的测试集':'还没有测试集。先生成 5 条问题看看，或上传已有问题。'}</p>}</div>
    </>}
  </section>
}
