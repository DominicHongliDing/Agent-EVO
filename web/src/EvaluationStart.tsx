import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, FileCheck2, FileUp, FlaskConical, MessageSquareText, Play, Upload } from 'lucide-react'
import { ContentTransition } from './Motion'
import AgentWorkbench from './AgentWorkbench'
import MaterialTemplates from './MaterialTemplates'
import {hostedMode} from './publicSnapshot'
import { answersApi, JudgeSetup } from './answerClient'
import type { AnswerTurn } from './answerClient'
import { api } from './api'
import './answers.css'

type ImportFile = { import_id: string; filename: string; columns: string[]; mapping: Record<string, string>; ambiguous: string[]; rows: { line: number; value: Record<string, unknown> }[] }
type Preview = { valid: boolean; total: number; turn_count: number; judge_segments: number; errors: { line: number; message: string }[]; matches: { matched: number; unmatched: number; conflict: number }; records: { conversation_id: string; turns: AnswerTurn[] }[] }
const fields: Record<string, string> = { question: '用户问题', answer: 'Agent 回答', reference: '参考依据（选填）', conversation: '会话 ID', turn: '轮次', case_id: '用例 ID', version: '测试集版本', trace: '执行轨迹' }

export default function EvaluationStart({ initialSelection, onCreated, onImported }: { initialSelection?: { datasetId: string; caseIds: string[] }; onCreated: (id: string) => void; onImported: (id: string) => void }) {
  const [purpose,setPurpose]=useState('quality')
  const [flow, setFlow] = useState<'answers' | 'dataset' | ''>(initialSelection ? 'dataset' : '')
  useEffect(() => { if (initialSelection) setFlow('dataset') }, [initialSelection])
  return <div className={`answers-app evaluation-start ${flow ? "evaluation-flow" : ""}`}><ContentTransition identity={flow || 'choose'}>
    {flow && <button className="back-link" onClick={() => setFlow('')}><ArrowLeft size={15}/> 返回评测方式</button>}
    {!flow && <><div className="page-heading"><div><div className="eyebrow">START AN EVALUATION</div><h1>从你手里的材料开始</h1><p>评一份已有回答，或用一组问题验证 Agent 的新表现。</p></div></div><div className="ai-tabs" aria-label="这次想做什么判断">{[['quality','检查当前质量'],['compare','比较两个版本'],['regression','验证已知问题']].map(([id,label])=><button key={id} aria-pressed={purpose===id} onClick={()=>setPurpose(id)}>{label}</button>)}</div><p className="ai-caption">{purpose==='compare'?'使用相同题库与评分标准比较两次真实运行；新增题与未知项单独列出。':purpose==='regression'?'从已确认的问题选择原题，固定预期后创建独立重测记录。':'先明确任务要求，再看回答、依据和仍未覆盖的情况。'}</p><div className="ai-example"><MessageSquareText size={20}/><div><strong>第一次使用？先看 Clinical 的真实记录</strong><p>50 条历史工程记录：看问题、查依据、理解改进方向。无需 API Key，不会重新运行。</p></div><a className="outline" href={hostedMode?'?space=history&view=batches':'https://dominicspace.com/apps/evaluation/index.html?space=history&view=batches'}>查看公开示例 <ArrowRight size={14}/></a></div><div className="ai-start-grid">
      <button className="ai-choice" onClick={() => setFlow('answers')}><span className="ai-choice-icon"><FileCheck2 size={27}/></span><span className="small-tag">已有问答 · 无需接入</span><h2>评估已有回答</h2><p>上传回答文件或粘贴对话，看看哪里回答得好，哪里需要改进。</p><span className="ai-path">上传材料 <ArrowRight size={14}/> 确认内容 <ArrowRight size={14}/> 查看结果</span><span className="ai-choice-action">上传回答 / 粘贴对话 <ArrowRight size={18}/></span></button>
      <button className="ai-choice" onClick={() => setFlow('dataset')}><span className="ai-choice-icon"><FlaskConical size={27}/></span><span className="small-tag">持续验证 · 复用测试题</span><h2>用测试集运行 Agent</h2><p>准备适合你的问题，连接自己的 Agent，验证当前表现或版本改进。</p><span className="ai-path">选择问题 <ArrowRight size={14}/> 确认调用 <ArrowRight size={14}/> 查看结果</span><span className="ai-choice-action">选择测试集 <ArrowRight size={18}/></span></button>
    </div><p className="ai-caption">测试集保存问题与期望，调用配置负责取得回答。两种入口的结果都保存在“评测记录”。</p></>}
    {flow === 'answers' && <AnswerImport purpose={purpose} onImported={onImported}/>}
    {flow === 'dataset' && <AgentWorkbench purpose={purpose} initialSelection={initialSelection} onImported={onImported}/>}
  </ContentTransition></div>
}

function AnswerImport({ onImported,purpose='quality' }: {purpose?:string; onImported: (id: string) => void }) {
  const [file, setFile] = useState<ImportFile>(), [mapping, setMapping] = useState<Record<string, string>>({}), [preview, setPreview] = useState<Preview>(), [paste, setPaste] = useState(''), [mode, setMode] = useState('file')
  const [name, setName] = useState(''), [dataset, setDataset] = useState(''), [datasets, setDatasets] = useState<{ dataset_id: string; name: string; version: string }[]>([])
  const [confirmed, setConfirmed] = useState(false), [order, setOrder] = useState(false), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [checking, setChecking] = useState(false)
  useEffect(() => { api<{ items: typeof datasets }>('/datasets').then(r => setDatasets(r.items)).catch(e => setError(e.message)) }, [])
  useEffect(() => {
    if (!file) return
    let active = true; setChecking(true); setPreview(undefined)
    const timer = setTimeout(() => { answersApi<Preview>(`/imports/${file.import_id}/preview`, { method: 'POST', body: JSON.stringify({ mapping, dataset_id: dataset, confirm_order: order }) }).then(p => active && setPreview(p)).catch(e => active && setError(e.message)).finally(() => active && setChecking(false)) }, 180)
    return () => { active = false; clearTimeout(timer) }
  }, [file, mapping, dataset, order])
  async function upload(input: File) {
    setBusy(true); setError('')
    try { const body = new FormData(); body.append('file', input); const item = await answersApi<ImportFile>('/imports', { method: 'POST', body }); setFile(item); setMapping(item.mapping); setName(input.name.replace(/\.[^.]+$/, '')); setConfirmed(false); setOrder(false); setDataset('') } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function save(score: boolean) {
    if (!file || !preview?.valid) return
    setBusy(true); setError('')
    try { const result = await answersApi<{ batch_id: string; reused: boolean }>(`/imports/${file.import_id}/commit`, { method: 'POST', body: JSON.stringify({ mapping, dataset_id: dataset, confirm_order: order, name, reviewed_deidentified: confirmed }) });
      // A repeated submission reopens the immutable batch and does not bill a second judge run.
      if (score && !result.reused) await answersApi(`/batches/${result.batch_id}/judge`, { method: 'POST', body: '{}' })
      onImported(result.batch_id)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  function template() { const link = document.createElement('a'), url = URL.createObjectURL(new Blob(['\ufeff用户问题,Agent 回答,参考答案\r\n"请把我们的会议改到周四下午，并确认新的时间。","已记下，会议时间为周四下午。","应采用周四下午，不保留原时间。"\r\n'], { type: 'text/csv;charset=utf-8' })); link.href = url; link.download = '回答导入模板.csv'; link.click(); URL.revokeObjectURL(url) }
  return <section className="import-task"><div className="page-heading"><div><div className="eyebrow">REVIEW EXISTING ANSWERS</div><h1>{file ? '确认你要评测的内容' : '把回答交给我们'}</h1><p>{file ? '检查问答和轮次，确认后保存或开始评分。' : '无需创建 Agent 或编写脚本，先看真实问答的质量。'}</p></div></div>
    {purpose!=='quality'&&<p className="ai-caption">{purpose==='compare'?'请分别导入两个版本在同题上的回答，关联同一测试集版本。保存后在评测记录中选择基线；只有一份回答时暂不判断版本改善。':'请导入修复后对原问题的真实回答，并关联原测试集版本。导入材料未经独立执行核验，审核时仍需核对业务来源。'}</p>}<ol className="ai-steps"><li className={!file ? 'current' : 'done'}>1 上传材料</li><li className={file ? 'current' : ''}>2 确认内容</li><li>3 查看结果</li></ol>
    {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>关闭</button></div>}
    <div className="flow-scroll" role="region" aria-label="回答材料与评测设置" tabIndex={0}>{!file ? <section className="card ai-upload-card"><div className="ai-tabs"><button aria-pressed={mode === 'file'} onClick={() => setMode('file')}><FileUp size={16}/> 上传文件</button><button aria-pressed={mode === 'paste'} onClick={() => setMode('paste')}><MessageSquareText size={16}/> 粘贴对话</button></div>
      {mode === 'file' ? <><label className="ai-drop"><Upload size={32}/><strong>{busy ? '正在读取文件…' : '选择回答文件'}</strong><span>Excel、CSV、JSON、JSONL · 最大 5 MiB</span><span>至少包含用户问题和 Agent 回答</span><input aria-label="上传回答文件" type="file" accept=".xlsx,.csv,.json,.jsonl" disabled={busy} onChange={e => { if (e.target.files?.[0]) void upload(e.target.files[0]); e.target.value = '' }}/></label></> : <><label>完整对话<textarea aria-label="粘贴完整对话" rows={10} placeholder={'用户：刚才说错了，改成周四下午。\n助手：已按周四下午整理。\n用户：请再确认一次时间。\n助手：会议在周四下午。'} value={paste} onChange={e => setPaste(e.target.value)}/></label><button className="primary" disabled={busy || !paste.trim()} onClick={() => void upload(new File([paste], '粘贴的对话.txt', { type: 'text/plain' }))}>识别这段对话 <ArrowRight size={15}/></button></>}
      <MaterialTemplates kind="answers"/><div className="material-capabilities"><strong>材料决定可以检查的范围</strong><p>只有问答：检查需求与表达。完整对话：检查前后文与更正。附参考资料：核对事实依据。附执行步骤：进一步排查过程。</p><p>缺少资料的部分会保留“无法判断”，不会自动补造证据。请使用合成或已脱敏记录。</p></div></section> : <>
      <section className="card"><div className="card-head"><div><h2>{file.filename}</h2><p>{checking ? '正在核对…' : `识别到 ${preview?.total ?? 0} 段对话 · ${preview?.turn_count ?? 0} 轮问答`}</p></div><button className="text-button" disabled={busy} onClick={() => { setFile(undefined); setPreview(undefined) }}>更换材料</button></div>
        <div className="ai-mapping">{['question','answer','reference'].map(f => <label key={f}>{fields[f]}<select aria-label={fields[f] + '所在列'} value={mapping[f] || ''} onChange={e => setMapping({ ...mapping, [f]: e.target.value })}><option value="">{f === 'reference' ? '没有参考依据' : '请选择列'}</option>{file.columns.map(c => <option key={c}>{c}</option>)}</select></label>)}</div>
        <details className="ai-disclosure"><summary>多轮对话、用例关联与轨迹</summary><div className="ai-mapping">{['conversation','turn','case_id','version','trace'].map(f => <label key={f}>{fields[f]}<select value={mapping[f] || ''} onChange={e => setMapping({ ...mapping, [f]: e.target.value })}><option value="">不使用</option>{file.columns.map(c => <option key={c}>{c}</option>)}</select></label>)}</div><label className="ai-check"><input type="checkbox" checked={order} onChange={e => setOrder(e.target.checked)}/>缺少轮次时，按文件顺序排列同一会话</label><label>关联已有测试集（可选）<select aria-label="关联已有测试集" value={dataset} onChange={e => setDataset(e.target.value)}><option value="">独立评测这份文件</option>{datasets.map(d => <option key={d.dataset_id} value={d.dataset_id}>{d.name} · {d.version}</option>)}</select></label><p>通过用例 ID、版本和问题内容核对，不按行号或相似文本猜测。</p>{dataset && preview && <p>匹配 {preview.matches.matched} 轮 · 未匹配 {preview.matches.unmatched} 轮 · 冲突 {preview.matches.conflict} 轮</p>}</details>
        {!!preview?.errors.length && <div className="ai-errors" role="alert"><strong>请先修正这些问题</strong>{preview.errors.map((e, i) => <p key={i}>{e.line ? `第 ${e.line} 行：` : ''}{e.message}</p>)}</div>}
        <div className="ai-preview">{preview?.records.map((r, i) => <article key={i}><h3>对话 {i+1}{r.conversation_id && <small> · {r.conversation_id}</small>}</h3>{r.turns.map(t => <div key={t.turn} className="ai-preview-turn"><span>第 {t.turn} 轮 · 来源行 {t.line}</span><p><strong>用户</strong>{t.question}</p><p><strong>Agent</strong>{t.answer}</p>{t.reference && <p><strong>参考依据</strong>{t.reference}</p>}{t.linked_case && <small>已关联测试集 {t.linked_case.version} · {t.linked_case.case_id}</small>}</div>)}</article>)}</div>
        <details className="ai-disclosure"><summary>查看文件原始字段</summary><pre>{JSON.stringify(file.rows, null, 2)}</pre></details>
      </section>
      <section className="card ai-review-settings"><h2>这次怎么评</h2><p>逐轮检查需求覆盖、相关性与表达、上下文更正；有参考依据时再判断事实一致性。缺失材料的维度保留“待判断”，关键风险单独显示。</p><label>记录名称<input aria-label="导入记录名称" value={name} maxLength={120} onChange={e => setName(e.target.value)}/></label><JudgeSetup onReady={setReady}/><label className="ai-check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>已核对问答和轮次，内容为合成或已脱敏数据。</label><p className="ai-caption">将评审 {preview?.total ?? 0} 段对话，预计 {preview?.judge_segments ?? 0} 次裁判请求（格式失败时每段最多补判 1 次）。长对话分段检查，跨段上下文另标待复核。不会重新调用 Agent。问答和参考依据会发送至所配置的百炼裁判。</p></section>
    </>}</div>
    {file && <footer className="task-footer"><span>{checking ? "正在核对材料…" : `已识别 ${preview?.total ?? 0} 段对话 · ${preview?.turn_count ?? 0} 轮`}</span><div className="ai-actions"><button className="outline" disabled={busy || checking || !preview?.valid || !confirmed} onClick={() => void save(false)}>先保存，稍后评分</button><button className="primary" disabled={busy || checking || !preview?.valid || !confirmed || !ready} onClick={() => void save(true)}>{busy ? '正在提交…' : '开始评测'} <Play size={15}/></button></div></footer>}
  </section>
}
