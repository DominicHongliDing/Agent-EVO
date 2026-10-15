import { useEffect, useState } from 'react'
import { Cloud, RefreshCw } from 'lucide-react'
import { localRequest } from './localClient'

export default function ResultOperations({ runIds, single = false, onUpdated }: { runIds: string[]; single?: boolean; onUpdated?: () => void }) {
  const [preview, setPreview] = useState<{ items: unknown[] }>(), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  const [record, setRecord] = useState<{ script?: { process_status: string; evaluator_status: string }; sync: { state: string; last_error?: string }; script_logs?: unknown[] }>()
  const identity = runIds.join(',')
  useEffect(() => { setPreview(undefined); setConsent(false); setMessage(''); setError(''); setRecord(undefined); if (single && runIds[0]) void localRequest<typeof record>('/runs/' + runIds[0]).then(setRecord).catch(e => setError(e.message)) }, [identity, single])
  async function action(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); onUpdated?.() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }
  async function operate(command: string, notice: string) {
    await localRequest('/runs/' + runIds[0] + '/' + command, { method: 'POST' })
    setMessage(notice); if (single) setRecord(await localRequest('/runs/' + runIds[0]))
  }
  return <section className="record-operations" aria-label="运行与同步"><h3>{single ? '运行与结果同步' : '同步本批次结果'}</h3><p>结果先保存在本机。确认内容后可加入线上同步队列，未连接时保留待传状态。</p>
    {error && <p role="alert" className="bad">{error}</p>}{message && <p role="status">{message}</p>}
    {record?.script?.evaluator_status === 'failed' && <p>评分脚本失败。业务回答仍然保留，可检查日志后只重新评分。</p>}
    <div className="le-actions"><button className="outline" disabled={busy || !runIds.length || runIds.length > 100} onClick={() => void action(async () => { setPreview(await localRequest('/exports/preview', { method: 'POST', body: JSON.stringify({ run_ids: runIds }) })); setConsent(false) })}><Cloud size={15}/>预览并同步 {runIds.length} 条</button>
    {single && <button className="outline" disabled={busy} onClick={() => void action(() => operate('sync-retry', '已请求补传，不会再次调用 Agent。'))}><RefreshCw size={14}/>重试同步</button>}
    {single && record?.script && (['running','queued'].includes(record.script.process_status) ? <button className="outline danger" disabled={busy} onClick={() => void action(() => operate('cancel', '停止请求已提交；已发出的业务请求可能仍会完成。'))}>停止此条</button> : <button className="outline" disabled={busy} onClick={() => void action(() => operate('rescore', '已加入重新评分队列，不会重新调用 Agent；模型评审可能产生独立费用。'))}>只重新评分</button>)}</div>
    {preview && <div><p>将同步 {preview.items.length} 条记录的输入、回答、处理过程与评分。脚本源码和模型凭证不会同步。</p><details><summary>核对脱敏后的完整内容</summary><pre>{JSON.stringify(preview, null, 2)}</pre></details><label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>我已检查内容，确认是合成或脱敏数据。</label><button className="primary" disabled={!consent || busy} onClick={() => void action(async () => { await localRequest('/exports', { method: 'POST', body: JSON.stringify({ run_ids: runIds, reviewed_deidentified: true }) }); setPreview(undefined); setMessage('已加入持久同步队列。可以继续查看和评测，不会重复调用 Agent。') })}>确认同步</button></div>}
    {!!record?.script_logs?.length && <details><summary>本地脚本日志</summary><pre>{JSON.stringify(record.script_logs, null, 2)}</pre></details>}
    {record?.sync.last_error && <p>同步需处理：{record.sync.last_error}</p>}
  </section>
}
