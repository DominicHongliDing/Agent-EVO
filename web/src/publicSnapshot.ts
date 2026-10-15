// The public build reuses the local UI. It never contacts a business API.
export const hostedMode = document.documentElement.dataset.evoMode === 'clinical-public'
const viewParams = new URLSearchParams(location.search || '')
export const personalMode = viewParams.get('space') === 'mine' || (hostedMode && !viewParams.has('space') && !viewParams.has('run') && !viewParams.has('batch'))
export const publicMode = hostedMode && !personalMode
export const localOnlyTitle = publicMode ? '此操作在本地评测平台执行；官网只读展示已有记录' : undefined
type Row = Record<string, any>
export type Snapshot = { primary_batch_id: string; exported_at: string; redaction: string; statistics: Row; agents: Row[]; datasets: Row[]; cases: Row[]; batches: Row[]; runs: Record<string, Row> }
let pending: Promise<Snapshot> | undefined
const detailRequests = new Map<string, Promise<Row>>()
export async function readJson<T>(response: Response, label = '服务响应'): Promise<T> {
  if (!response.ok) throw new Error(`${label}读取失败（HTTP ${response.status}），请检查服务状态`)
  try { return await response.json() as T } catch { throw new Error(`${label}格式异常：无法读取 JSON，请刷新重试；管理员可检查响应类型及压缩配置。`) }
}
export function loadSnapshot() {
  return pending ||= fetch('/apps/evaluation/snapshot.json', { cache: 'no-store' }).then(response => readJson<Snapshot>(response, 'Clinical 公开记录')).catch(e => { pending = undefined; throw e })
}

export async function snapshotRequest<T>(path: string, init?: RequestInit): Promise<T> {
  if (init?.method && init.method.toUpperCase() !== 'GET') throw new Error(localOnlyTitle)
  const data = await loadSnapshot()
  const url = new URL(path, location.origin), p = url.pathname
  const items = (rows: Row[]) => ({ items: url.searchParams.get('deleted') === 'true' ? [] : rows })
  let result: unknown
  if (p === '/cases') result = items(data.cases)
  else if (p === '/agents') result = items(data.agents)
  else if (p === '/datasets') result = items(data.datasets)
  else if (p === '/batches') result = items(data.batches)
  else if (p === '/health') result = { platform: 'public_snapshot', services: {}, worker: {}, unihr_credentials_configured: false, unihr_usage_db_configured: false }
  else if (/^\/runs\/[^/]+$/.test(p)) {
    const id = p.split('/')[2]
    if (!data.runs[id]) throw new Error('该记录未公开')
    if (!detailRequests.has(id)) detailRequests.set(id, fetch(`/apps/evaluation/runs/${encodeURIComponent(id)}.json`, { cache: 'no-store' }).then(r => readJson<Row>(r, '记录证据')).catch(e => { detailRequests.delete(id); throw e }))
    result = await detailRequests.get(id)
  }
  else if (/^\/batches\/[^/]+\/report$/.test(p)) {
    const batch = data.batches.find(b => b.batch_id === p.split('/')[2])
    if (!batch) throw new Error('该批次未公开')
    const dimensions: Row = {}, critical: Row[] = []
    for (const row of batch.runs) for (const v of data.runs[row.run_id].verdicts) {
      const count = dimensions[v.dimension] ||= { pass: 0, fail: 0, unjudged: 0 }
      count[v.result]++
      if (v.critical && v.result === 'fail') critical.push({ run_id: row.run_id, ...v })
    }
    result = { batch_id: batch.batch_id, total: batch.total, finished: batch.finished, dimensions, critical_failures: critical, clinical_validation: '医生临床验证尚未开展' }
  } else if (/^\/batches\/[^/]+\/failures$/.test(p)) {
    const batch = data.batches.find(b => b.batch_id === p.split('/')[2])
    if (!batch) throw new Error('该批次未公开')
    const dim = url.searchParams.get('dimension'), critical = url.searchParams.get('critical') === 'true', q = (url.searchParams.get('q') || '').toLowerCase()
    const rows = batch.runs.flatMap((row: Row) => {
      const run = data.runs[row.run_id]
      const findings = run.verdicts.filter((v: Row) => v.result === 'fail' && (!dim || (dim === 'context_all' ? v.dimension === 'context' || v.dimension.startsWith('context_') : v.dimension === dim)) && (!critical || v.critical))
      if (!findings.length && (dim || critical || !['failed', 'timed_out', 'blocked'].includes(run.status))) return []
      const problem = { ...row, message: run.case.message, title: run.case.title, error_code: run.error_code, findings, critical: findings.some((v: Row) => v.critical) }
      return JSON.stringify(problem).toLowerCase().includes(q) ? [problem] : []
    })
    result = { items: rows, assertion_count: rows.reduce((sum: number, r: Row) => sum + r.findings.length, 0) }
  } else throw new Error('此数据不在 Clinical 公开范围内')
  if (!result) throw new Error('该记录未公开')
  return result as T
}
