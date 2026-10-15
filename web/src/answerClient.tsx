import { useEffect, useState } from 'react'
import { personalMode } from './publicSnapshot'

export type AnswerTurn = { turn: number; question: string; answer: string; reference: string; line: number; trace: unknown; linked_case?: { dataset_id: string; case_id: string; version: string } }
export type Citation = { ref: string; quote: string }
export type Dimension = { dimension: string; score: number | null; reason: string; evidence: Citation[] }
export type Assessment = { assessment_id: string; status: string; created_at: string; result: { reason?: string; summary?: string; quality?: string; judge_calls?: number; turns?: { turn: number; dimensions: Dimension[] }[]; critical_findings?: { reason: string; evidence: Citation[] }[]; [key: string]: unknown } }
export type AnswerRecord = { record_id: string; batch_id: string; conversation_id: string; source_lines: number[]; source: { import_id?: string; filename: string; sha256: string; execution_verified: boolean }; turns: AnswerTurn[]; assessments: Assessment[] }
export type AnswerBatch = { batch_id: string; name: string; created_at: string; pinned: number; deleted_at?: string; total: number; records: { record_id: string; question: string; turn_count: number; status: string; quality: string; critical_count: number }[] }
export type JudgeStatus = { configured: boolean; model: string; provider: string }
export const dimensionNames: Record<string, string> = { factual: '与参考依据一致', coverage: '需求覆盖', relevance: '相关性与表达', context: '上下文与更正遵循' }
export const statusNames: Record<string, string> = { not_started: '待评分', queued: '排队中', running: '正在评分', completed: '评分完成', failed: '评分请求失败', unjudged: '待复核', interrupted: '评分中断', cancelled: '已取消', pass: '已评分维度达标', fail: '发现问题' }

export async function answersApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (personalMode) return (await import('./browserAnswers')).browserAnswerRequest<T>(path, init)
  const headers = new Headers(init.headers)
  headers.set('X-EVO-Answers', '1')
  const token = sessionStorage.getItem('evo_access_token')
  if (token) headers.set('X-EVO-Token', token)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const response = await fetch('/api/answers' + path, { ...init, headers, cache: 'no-store' })
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('回答评测服务尚未就绪，请确认已启动新版后端。')
  const value = await response.json()
  if (!response.ok) throw new Error(typeof value.detail === 'string' ? value.detail : '字段不完整，请核对输入')
  return value
}

export async function downloadAnswerFile(record: AnswerRecord) {
  if (personalMode) { const file = await (await import('./browserAnswers')).browserOriginalFile(record.source.import_id || ''); const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=record.source.filename;a.click();URL.revokeObjectURL(url);return }
  const token = sessionStorage.getItem('evo_access_token')
  const response = await fetch('/api/answers/imports/' + record.source.import_id + '/file', { headers: token ? { 'X-EVO-Token': token } : {} })
  if (!response.ok) throw new Error('原文件下载失败，解析后的字段仍保留。')
  const url = URL.createObjectURL(await response.blob()), link = document.createElement('a')
  link.href = url; link.download = record.source.filename; link.click(); URL.revokeObjectURL(url)
}

export function JudgeSetup({ onReady }: { onReady?: (ready: boolean) => void }) {
  const [status, setStatus] = useState<JudgeStatus>(), [key, setKey] = useState(''), [model, setModel] = useState('qwen3.6-flash'), [error, setError] = useState(''), [busy, setBusy] = useState(false), [editing, setEditing] = useState(false)
  useEffect(() => { let active = true; answersApi<JudgeStatus>('/judge').then(s => { if (active) { setStatus(s); setModel(s.model); onReady?.(s.configured) } }).catch(e => active && setError(e.message)); return () => { active = false } }, [])
  return <section className="ai-judge">
    <div><strong>独立评分 · 阿里云百炼</strong><p>{status?.configured ? `已配置 ${status.model}，评分时发送本次问答与参考依据。` : '填写裁判 API Key 后可评分，问答也可以先保存。'} {personalMode ? 'Key 仅保存在当前页面内存，评分时经本站转发至百炼，刷新后需重填。' : 'Key 只保存在本地服务进程中。'}</p></div>
    {status?.configured && <button className="text-button" onClick={() => setEditing(!editing)}>{editing ? '收起' : '更换配置'}</button>}
    {(!status?.configured || editing) && <div className="ai-config"><label>裁判 API Key<input type="password" autoComplete="off" value={key} placeholder="输入百炼 API Key" onChange={e => setKey(e.target.value)}/></label><label>裁判模型<input value={model} onChange={e => setModel(e.target.value)}/></label><button className="outline" disabled={busy || key.trim().length < 10} onClick={async () => { setBusy(true); setError(''); try { const s = await answersApi<JudgeStatus>('/judge', { method: 'POST', body: JSON.stringify({ api_key: key, model }) }); setStatus(s); setKey(''); setEditing(false); onReady?.(s.configured) } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>保存本次配置</button></div>}
    {error && <p role="alert" className="ai-error">{error}</p>}
  </section>
}
