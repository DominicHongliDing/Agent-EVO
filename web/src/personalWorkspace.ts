import { hostedMode, readJson } from './publicSnapshot'

type Row = Record<string, any>
type State = { datasets: Row[]; cases: Row[]; batches: Row[]; runs: Record<string, Row>; assignments: Record<string, string[]> }
export type Connection = { provider: string; model: string; key: string }
const builtin = ['agent_clinical']
const stamp = () => new Date().toISOString()
const uid = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
let connection: Connection | null = null
let active: { batch: string; controller: AbortController } | null = null
let state: State
let db: IDBDatabase
let initializing: Promise<void> | undefined
let releaseExecution: (() => void) | undefined
const locks = () => typeof navigator !== 'undefined' ? navigator.locks : undefined
async function executionHeld() { return Boolean((await locks()?.query())?.held?.some(lock => lock.name === 'agent-evo-personal-execution')) }
async function acquireExecution() {
  if (!locks()) return
  await new Promise<void>((resolve, reject) => {
    void locks()!.request('agent-evo-personal-execution', { ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error('另一个页面正在执行评测，请在原页面停止或等待完成')); return }
      await new Promise<void>(release => { releaseExecution = release; resolve() })
    }).catch(reject)
  })
}
async function readState() { return new Promise<State>((resolve, reject) => { const req = db.transaction('workspace').objectStore('workspace').get('mine'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error) }) }
export const visitorPath = hostedMode ? '/api' : '/api/visitor'
export function setConnection(value: Connection | null) { if (!value) active?.controller.abort(); connection = value ? { ...value } : null }
export function connectionSummary() { return connection ? { provider: connection.provider, model: connection.model } : null }
export function stopPersonalBatch() { active?.controller.abort() }
export function runningPersonalBatch() { return active?.batch }

export async function visitorResponse(path: string, init?: RequestInit) {
  const response = await fetch(visitorPath + path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  if (!response.ok) {
    // The business service deliberately returns safe messages, never provider bodies.
    const data = await response.json().catch(() => null)
    throw new Error(`HTTP ${response.status} · ${typeof data?.detail === 'string' ? data.detail : '业务请求失败，请检查连接与输入'}`)
  }
  return response
}
export async function visitorJson<T>(path: string, init?: RequestInit) { return readJson<T>(await visitorResponse(path, init), 'Clinical 业务服务') }
async function sha(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('') }
async function save() {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('workspace', 'readwrite'); tx.objectStore('workspace').put(state, 'mine')
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error('浏览器存储写入失败，请导出记录并检查空间')); tx.onabort = tx.onerror
  })
}
async function init() {
  return initializing ||= (async () => {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('agent-evo-personal-v1', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('workspace')
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(new Error('无法打开浏览器个人工作区'))
    })
    state = await readState()
    if (!state) {
      state = { datasets: [], cases: [], batches: [], runs: {}, assignments: {} }
      for (const profile of ['clinical']) {
        const sample = [{ case_id: 'clinical_sleep', title: '整理睡眠情况', message: '最近三天睡不好，白天也觉得疲惫。我想先整理情况，需要补充哪些信息？' },
             { case_id: 'clinical_followup', title: '准备复诊记录', message: '我准备复诊，想把最近一周的睡眠、情绪变化和用药情况记下来。请帮我列一个记录提纲。' },
             { case_id: 'clinical_correction', title: '更正持续时间', message: '最近两周睡不好，想整理一下情况。', turns: [{ message: '最近两周睡不好，想整理一下情况。' }, { message: '刚才说错了，是最近三天。请按这个时间帮我整理需要补充的信息。', checks: [{ dimension: 'context_correction', title: '采用更正后时间', must_include_any: ['三天', '3 天', '3天'] }] }] }]
        await importDataset({ name: 'Clinical 入门用例', profile, version: 'v1', filename: 'starter.json', content: JSON.stringify(sample.map(x => ({ ...x, synthetic: true }))) })
      }
    }
    let interrupted = false
    for (const run of Object.values(state.runs)) if (!(await executionHeld()) && ['queued', 'running'].includes(run.status)) {
      interrupted = true
      run.status = 'cancelled'; run.finished_at = stamp(); run.error_code = 'page_interrupted'
      addEvent(run, 'runner.interrupted', 'cancelled', { message: '页面刷新或关闭，执行已中断；不会自动重发请求。' }); evaluate(run)
    }
    if (interrupted) await save()
  })().catch(e => { initializing = undefined; throw e })
}
function csvRows(content: string): Row[] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false
  for (let i = 0; i <= content.length; i++) {
    const c = content[i]
    if (c === '"') { if (quoted && content[i + 1] === '"') { field += '"'; i++ } else quoted = !quoted }
    else if (!quoted && (c === ',' || c === '\n' || c === undefined)) {
      row.push(field.replace(/\r$/, '')); field = ''
      if (c !== ',') { if (row.some(x => x.trim())) rows.push(row); row = [] }
    } else field += c
  }
  if (quoted || rows.length < 2) throw new Error('CSV 格式不完整')
  const headers = rows.shift()!
  return rows.map(values => Object.fromEntries(headers.map((name, i) => [name, values[i] || ''])))
}
export function previewPersonalDataset(draft: Row) {
  const errors: { line: number; message: string }[] = [], cases: Row[] = [], ids = new Set<string>()
  let rows: { line: number; data: Row }[] = []
  try {
    if (!draft.name?.trim() || !['clinical','generic'].includes(draft.profile)) throw new Error('请选择测试集用途并填写名称')
    if (!/^v\d+$/.test(draft.version)) throw new Error('版本须为 v1、v2 等格式')
    if (new TextEncoder().encode(draft.content).length > 5_242_880) throw new Error('文件超过 5 MiB')
    const content = draft.content.replace(/^\uFEFF/, '')
    if (/\.jsonl$/i.test(draft.filename)) {
      content.split(/\r?\n/).forEach((line: string, i: number) => { if (line.trim()) { try { rows.push({ line: i + 1, data: JSON.parse(line) }) } catch { errors.push({ line: i + 1, message: 'JSON 语法错误' }) } } })
    } else if (/\.json$/i.test(draft.filename)) { const data = JSON.parse(content); const list = Array.isArray(data) ? data : data.cases; if (!Array.isArray(list)) throw new Error('JSON 须为数组或包含 cases 数组'); rows = list.map((data, i) => ({ line: i + 1, data })) }
    else if (/\.csv$/i.test(draft.filename)) rows = csvRows(content).map((data, i) => ({ line: i + 2, data }))
    else throw new Error('只支持 JSON、JSONL、CSV')
    if (!rows.length || rows.length > 1000) throw new Error('测试集须包含 1–1,000 条用例')
  } catch (e) { errors.push({ line: 0, message: e instanceof SyntaxError ? '文件 JSON 语法错误' : (e as Error).message }) }
  for (const { line, data } of rows.slice(0, 1000)) {
    try {
      if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('用例须为对象')
      const serial = JSON.stringify(data)
      if (/"(?:[^"\\]*(?:password|token|api.?key|secret|credential)[^"\\]*)"\s*:/i.test(serial) || /\bsk-[\w-]{16,}|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\d)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(serial)) throw new Error('发现凭证字段或个人标识，请先脱敏')
      if (data.agent && data.agent !== draft.profile) throw new Error('用例与所选 Agent 不兼容')
      if (!['engineering_draft', '', undefined].includes(data.gold_status)) throw new Error('上传仅接受工程草案，不能冒充已审批金标')
      if (![true, 'true', undefined, ''].includes(data.synthetic)) throw new Error('仅接受合成或脱敏用例')
      const id = String(data.case_id || `row_${line}`)
      if (!/^[a-z0-9][a-z0-9_-]{2,100}$/.test(id) || ids.has(id)) throw new Error('case_id 无效或重复'); ids.add(id)
      for (const field of ['expected', 'turns', 'fixtures', 'materials']) if (typeof data[field] === 'string') data[field] = data[field] ? JSON.parse(data[field]) : undefined
      if ((data.fixtures?.length || 0) > 0) throw new Error('访客运行不支持本机附件路径；请将材料写入 materials 的 name/text')
      if (typeof data.message !== 'string' || !data.message.trim() || data.message.length > 8000) throw new Error('message 须为 1–8,000 字符')
      const turns = data.turns || []
      if (!Array.isArray(turns) || (turns.length && (turns.length < 2 || turns.length > (draft.profile === 'clinical' ? 8 : 40) || turns[0].message !== data.message))) throw new Error('多轮须为 2–8 轮，首轮与 message 一致')
      for (const turn of turns) {
        if (typeof turn.message !== 'string' || !turn.message.trim() || turn.message.length > 8000) throw new Error('每轮 message 须为 1–8,000 字符')
        if (turn.checks && (!Array.isArray(turn.checks) || turn.checks.length > 20)) throw new Error('每轮 checks 最多 20 项')
        for (const check of turn.checks || []) {
          if (!['context_fact_retention', 'context_correction', 'context_constraint', 'context_topic_return', 'context_isolation'].includes(check.dimension)) throw new Error('上下文检查维度不支持')
          const required = check.must_include_any || [], excluded = check.must_exclude || []
          if (!Array.isArray(required) || !Array.isArray(excluded) || !(required.length + excluded.length) || required.length + excluded.length > 30 || [...required, ...excluded].some(x => typeof x !== 'string' || !x.trim() || x.length > 300)) throw new Error('上下文检查需提供非空词项条件')
        }
      }
      const materials = data.materials || (data.case_context_text ? [{ name: 'context.txt', text: data.case_context_text }] : [])
      if (!Array.isArray(materials) || materials.length > 3 || materials.some(m => !m || !/^[^/\\\x00-\x1f]{1,90}\.(txt|md)$/i.test(m.name) || typeof m.text !== 'string' || !m.text || m.text.length > 16000) || materials.reduce((n, m) => n + m.text.length, 0) > 24000) throw new Error('材料最多 3 份 TXT/MD，每份 16,000 字符，合计 24,000 字符')
      const expected = data.expected || {}
      if (typeof expected !== 'object' || Array.isArray(expected)) throw new Error('expected 须为对象')
      for (const k of ['output_contains', 'output_excludes']) if (expected[k] && (!Array.isArray(expected[k]) || expected[k].some((x: unknown) => typeof x !== 'string' || !x))) throw new Error('回答词项检查须为非空字符串数组')
      cases.push({ ...data, case_id: id, source_case_id: id, agent: draft.profile, title: data.title || data.message.slice(0, 60), category: data.category || (turns.length ? 'context' : 'general'), risk_level: data.risk_level || 'standard', synthetic: true, gold_status: 'engineering_draft', materials, expected, turns, fixtures: [] })
    } catch (e) { errors.push({ line, message: e instanceof SyntaxError ? '嵌套 JSON 字段语法错误' : (e as Error).message }) }
  }
  return { valid: errors.length === 0, total: rows.length, errors, preview: cases.slice(0, 5), cases }
}
async function importDataset(draft: Row) {
  const preview = previewPersonalDataset(draft)
  if (!preview.valid) throw new Error(preview.errors.map(e => `第 ${e.line} 行：${e.message}`).join('；'))
  const id = uid('dataset')
  const dataset = { dataset_id: id, name: draft.name.trim(), description: draft.description || '', version: draft.version, profile: draft.profile, source_filename: draft.filename, content_sha256: await sha(draft.content), created_at: stamp(), deleted_at: null, case_count: preview.cases.length }
  state.datasets.push(dataset); state.cases.push(...preview.cases.map(c => ({ ...c, case_id: `${id}_${c.case_id}`, dataset_id: id })))
  const agent = `agent_${draft.profile}`; state.assignments[agent] = [...(state.assignments[agent] || []), id]
  await save(); return dataset
}
function agents() { return builtin.map(agent_id => ({ agent_id, name: 'Clinical Agent', adapter_kind: agent_id.slice(6), base_url: 'Clinical 业务接口 · 自带 API Key', endpoint_path: '/runs', credential_env_prefix: '', dataset_ids: state.assignments[agent_id] || [] })) }
function addEvent(run: Row, node: string, status: string, payload: Row) { run.events.push({ seq: run.events.length + 1, kind: 'business_step', node, status, payload, created_at: stamp() }) }
function evaluate(run: Row) {
  const verdicts: Row[] = []
  const verdict = (dimension: string, result: string, rationale: string, critical = false, evidence = [`run:${run.run_id}`]) => verdicts.push({ dimension, result, rationale, critical: +critical, evaluator: 'visitor-rule-v1', evidence })
  const rows = run.output?.conversation_turns || []
  const answer = run.output?.result?.answer || ''
  verdict('business_execution', run.status === 'completed' ? 'pass' : 'fail', run.status === 'completed' ? '实际业务流返回完整答复，已保存全部事件。' : '业务未完成；查看最后的失败或中断步骤。')
  verdict('live_model', 'unjudged', '业务已记录模型步骤；现有接口未返回提供商用量与持久 Run ID，不计作已核验模型证据。')
  const contains = run.case.expected?.output_contains || [], excludes = run.case.expected?.output_excludes || []
  if (contains.length || excludes.length) verdict('answer', contains.every((s: string) => answer.includes(s)) && excludes.every((s: string) => !answer.includes(s)) ? 'pass' : 'fail', '按用例声明的回答词项核对；不代表语义或临床有效性。')
  else verdict('answer', 'unjudged', '未提供回答金标，需人工复核。')
  for (const row of rows) for (const check of run.case.turns?.[row.turn_index - 1]?.checks || []) {
    const body = row.output?.result?.answer || '', include = check.must_include_any || [], exclude = check.must_exclude || []
    const result = row.status !== 'completed' ? 'unjudged' : ((!include.length || include.some((x: string) => body.includes(x))) && exclude.every((x: string) => !body.includes(x)) ? 'pass' : 'fail')
    verdict(check.dimension, result, `第 ${row.turn_index} 轮 · ${check.title || check.dimension}：仅词项检查，需结合完整对话复核。`, check.critical, [`run:${run.run_id}:turn:${row.turn_index}`])
  }
  if (run.case.turns?.length) verdict('context_semantics', 'unjudged', '完整逐轮记录可用；未执行独立模型语义评审，词项通过不能当作上下文语义通过。')
  for (const dimension of ['intent', 'retrieval', 'source_selection', 'critical_safety']) verdict(dimension, 'unjudged', '未提供可核验金标或完整安全证据，需人工复核。', dimension === 'critical_safety')
  const failures = run.events.filter((e: Row) => ['failed', 'cancelled'].includes(e.status))
  const failed = failures.filter((e: Row) => e.node !== 'visitor.request').slice(-1)[0] || failures.slice(-1)[0]
  if (failed) verdict('business_node', 'fail', `失败节点：${failed.node}；${failed.payload.description || failed.payload.message || '请查看原始事件'}`, false, [`event:${failed.seq}`])
  run.verdicts = verdicts
  addEvent(run, 'diagnosis', 'completed', { findings: verdicts.map(v => ({ ...v, status: v.result, hypothesis: v.dimension === 'business_node' ? '业务该步骤未完成；需检查连接、额度、输入和服务状态。' : '仅基于本次可观察证据，尚不能确认内部根因。', alternative: '可能涉及输入条件、检索覆盖或服务异常，当前证据不能排除。', controlled_replay: '固定测试集指纹与模型，显式创建重跑批次；旧记录保留。' })) })
}
const clinicalIds = (batch: Row): string[] => batch.run_ids.filter((id: string) => state.runs[id]?.case.agent === 'clinical')
function batchView(batch: Row) { const runs = clinicalIds(batch).map((id: string) => { const r = state.runs[id]; return { run_id: id, case_id: r.case_id, status: r.status, model_calls: 0, live_model_verified: 0, agent: r.case.agent, category: r.case.category, title: r.case.title, agent_name: r.agent_name, dataset_name: r.dataset_name, created_at: r.created_at, error_code: r.error_code } }); return { ...batch, run_ids: clinicalIds(batch), label: runs.length === batch.run_ids.length ? batch.label : 'Clinical · 历史评测', total: runs.length, finished: runs.filter((r: Row) => !['queued', 'running'].includes(r.status)).length, live_model_verified: 0, runs } }
async function executeBatch(batch: Row, credentials: Connection, controller: AbortController) {
  try {
    for (const id of batch.run_ids) {
      const run = state.runs[id]
      if (run.status !== 'queued') continue
      if (controller.signal.aborted) { run.status = 'cancelled'; run.finished_at = stamp(); addEvent(run, 'runner.cancelled', 'cancelled', { message: '用户停止批次，未发起该用例' }); evaluate(run); await save(); continue }
      run.status = 'running'; run.started_at = stamp(); await save()
      let token = ''
      try {
        const session = await visitorJson<{ token: string }>('/sessions', { method: 'POST', body: JSON.stringify({ project: run.case.agent }), signal: controller.signal })
        token = session.token
        if (!token) throw new Error('业务会话未返回令牌')
        const sessionId = await sha(token); run.business_session_sha256 = sessionId
        addEvent(run, 'context.assembled', 'completed', { description: '每个用例建立独立业务会话，各轮复用同一会话。', session_sha256: sessionId })
        const turns = run.case.turns?.length ? run.case.turns : [{ message: run.case.message }]
        run.output = { business_status: 'running', result: {}, conversation_turns: [], model_evidence: { verified: false, reason: 'provider_usage_unavailable' } }
        for (let i = 0; i < turns.length; i++) {
          const row: Row = { turn_index: i + 1, message: turns[i].message, status: 'running', started_at: stamp(), conversation_id: sessionId, session_verified: true, model_calls: 0, model_evidence: { verified: false } }
          run.output.conversation_turns.push(row); addEvent(run, 'turn.accepted', 'running', { message: row.message, turn_index: i + 1 }); await save()
          const response = await visitorResponse('/runs', { method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...credentials, question: row.message, materials: i === 0 ? run.case.materials : [], task_id: 'auto' }) })
          if (!/application\/x-ndjson/i.test(response.headers.get('content-type') || '')) throw new Error('业务流格式异常：预期逐行 JSON')
          const reader = response.body?.getReader(); if (!reader) throw new Error('业务流为空')
          const decoder = new TextDecoder(); let buffer = '', finished = false, bytes = 0
          const consume = async (line: string) => {
            if (!line.trim()) return
            let event: Row
            try { event = JSON.parse(line) } catch { throw new Error('业务流某一行不是有效 JSON，已保留此前步骤') }
            // Do not persist an upstream echo of credentials even if a service regresses.
            if (JSON.stringify(event).includes(credentials.key)) throw new Error('业务流包含敏感凭证，已拒绝保存')
            const node = String(event.node || event.step || 'business.event')
            addEvent(run, node, String(event.status || 'observed'), { ...event, turn_index: i + 1 })
            if (event.status === 'failed') { row.status = 'failed'; row.error_code = node; await save(); throw new Error(`业务步骤 ${node} 失败，请检查 Key、额度、输入或网络`) }
            if (node === 'run' && typeof event.answer === 'string' && event.answer.trim()) { row.output = { result: { answer: event.answer, sources: event.sources, artifacts: event.artifacts }, business_status: 'succeeded' }; run.output.result = row.output.result; finished = true }
            await save()
          }
          try {
            while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 4_000_000) throw new Error('业务流超过 4 MB 上限'); buffer += decoder.decode(value, { stream: true }); let split; while ((split = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); await consume(line) } }
            buffer += decoder.decode(); if (buffer.trim()) await consume(buffer)
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
          if (!finished) throw new Error('业务流结束但未返回最终回答，不能算作完成')
          row.status = 'completed'; row.finished_at = stamp(); row.latency_ms = Date.parse(row.finished_at) - Date.parse(row.started_at); await save()
        }
        run.status = 'completed'; run.output.business_status = 'succeeded'
      } catch (e) {
        run.status = controller.signal.aborted ? 'cancelled' : 'failed'; run.error_code = controller.signal.aborted ? 'user_cancelled' : 'visitor_business_failed'
        const last = run.output?.conversation_turns?.slice(-1)[0]; if (last?.status === 'running') { last.status = run.status === 'cancelled' ? 'failed' : run.status; last.error_code = run.error_code }
        addEvent(run, 'visitor.request', run.status === 'cancelled' ? 'cancelled' : 'failed', { message: controller.signal.aborted ? '用户停止执行' : (e as Error).message })
        if (run.output) run.output.business_status = 'failed'
      } finally {
        if (token) await visitorResponse('/sessions', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) }).catch(() => {})
        token = ''; run.finished_at = stamp(); evaluate(run); await save()
      }
    }
  } finally { credentials.key = ''; active = null; releaseExecution?.(); releaseExecution = undefined }
}
async function createBatch(body: Row, retryOf?: Record<string, string>) {
  if (!connection) throw new Error('请先填写并验证自己的 API Key')
  if (active) throw new Error('当前已有执行批次，请等待完成或停止后再运行')
  if (!builtin.includes(body.agent_id)) throw new Error('仅允许 Clinical 内置示例')
  const dataset = state.datasets.find(d => d.dataset_id === body.dataset_id && !d.deleted_at)
  if (!dataset || !state.assignments[body.agent_id]?.includes(dataset.dataset_id)) throw new Error('测试集未分配给所选 Agent')
  if (!Array.isArray(body.case_ids) || !body.case_ids.length || body.case_ids.length > 100 || new Set(body.case_ids).size !== body.case_ids.length) throw new Error('每批请选择 1–100 条不同用例')
  const cases = body.case_ids.map((id: string) => state.cases.find(c => c.case_id === id && c.dataset_id === dataset.dataset_id)) as Row[]
  if (cases.some((c: Row | undefined) => !c || `agent_${c.agent}` !== body.agent_id)) throw new Error('用例与执行目标不一致')
  const batch: Row = { batch_id: uid('batch'), label: String(body.label || '个人评测').slice(0, 120), created_at: stamp(), pinned: 0, deleted_at: null, run_ids: [] }
  for (const c of cases) { const id = uid('run'); batch.run_ids.push(id); state.runs[id] = { run_id: id, batch_id: batch.batch_id, case_id: c.case_id, trace_id: uid('trace'), case: structuredClone(c), case_sha256: await sha(JSON.stringify(c)), agent: c.agent, agent_id: body.agent_id, agent_name: agents().find(a => a.agent_id === body.agent_id)!.name, dataset_id: dataset.dataset_id, dataset_name: dataset.name, status: 'queued', created_at: stamp(), model_calls: 0, live_model_verified: false, events: [], artifacts: [], verdicts: [], retry_of: retryOf?.[c.case_id], version: { execution_profile: 'deployed_visitor_business', provider: connection.provider, model: connection.model, dataset_sha256: dataset.content_sha256 }, model_evidence: { verified: false, reason: 'provider_usage_unavailable' } } }
  await acquireExecution()
  state.batches.unshift(batch)
  try { await save() } catch (e) { releaseExecution?.(); releaseExecution = undefined; throw e }
  const controller = new AbortController(); active = { batch: batch.batch_id, controller }
  void executeBatch(batch, { ...connection }, controller).catch(() => { for (const id of batch.run_ids) { const run = state.runs[id]; if (['queued', 'running'].includes(run.status)) { run.status = 'failed'; run.error_code = 'workspace_storage_error' } } })
  return batchView(batch)
}
export async function personalRequest<T>(path: string, request?: RequestInit): Promise<T> {
  return locks() ? locks()!.request('agent-evo-personal-data', () => handleRequest<T>(path, request)) : handleRequest<T>(path, request)
}
async function handleRequest<T>(path: string, request?: RequestInit): Promise<T> {
  await init()
  if (!active) state = await readState()
  const method = request?.method?.toUpperCase() || 'GET'
  if (method !== 'GET' && !active && await executionHeld()) throw new Error('另一个页面正在执行评测，请在原页面操作')
  const url = new URL(path, location.origin), p = url.pathname, body = request?.body ? JSON.parse(String(request.body)) : {}, deleted = url.searchParams.get('deleted') === 'true'
  const list = (rows: Row[]) => ({ items: rows.filter(r => Boolean(r.deleted_at) === deleted) })
  let result: any
  if (p === '/health' && method === 'GET') result = { platform: 'personal_workspace', services: {}, worker: {}, unihr_credentials_configured: false, unihr_usage_db_configured: false }
  else if (p === '/agents' && method === 'GET') result = { items: deleted ? [] : agents() }
  else if (/^\/agents\/[^/]+\/check$/.test(p) && method === 'POST') { if (!builtin.includes(p.split('/')[2])) throw new Error('Agent 不允许'); await visitorJson('/health'); result = { reachable: true, model_verified: false } }
  else if (/^\/agents\/[^/]+\/datasets$/.test(p) && method === 'PUT') { const id = p.split('/')[2]; if (!builtin.includes(id) || !Array.isArray(body.dataset_ids) || body.dataset_ids.some((d: string) => !state.datasets.some(item => item.dataset_id === d && !item.deleted_at && `agent_${item.profile}` === id))) throw new Error('测试集与 Agent 不兼容'); state.assignments[id] = [...new Set<string>(body.dataset_ids)]; await save(); result = agents().find(a => a.agent_id === id) }
  else if (p.startsWith('/agents')) throw new Error('新增、编辑与删除 Agent 暂停，仅允许 Clinical')
  else if (p === '/datasets/preview' && method === 'POST') result = previewPersonalDataset(body)
  else if (p === '/datasets' && method === 'POST') result = await importDataset(body)
  else if (p === '/datasets' && method === 'GET') result = list(state.datasets.filter(d => ['clinical','generic'].includes(d.profile)))
  else if (p.startsWith('/datasets/')) { const item = state.datasets.find(d => d.dataset_id === p.split('/')[2] && ['clinical','generic'].includes(d.profile)); if (!item) throw new Error('测试集不存在'); if (method === 'PATCH') { if (!body.name?.trim()) throw new Error('名称不能为空'); item.name = body.name.trim().slice(0, 100) } else if (method === 'POST' && /\/(delete|restore)$/.test(p)) { if (active && state.batches.find(b => b.batch_id === active?.batch)?.run_ids.some((id: string) => state.runs[id].dataset_id === item.dataset_id)) throw new Error('测试集正在执行，无法删除'); item.deleted_at = p.endsWith('/delete') ? stamp() : null } else throw new Error('操作不支持'); await save(); result = item }
  else if (p === '/cases') result = { items: state.cases.filter(c => ['clinical','generic'].includes(c.agent) && (!url.searchParams.get('dataset_id') || c.dataset_id === url.searchParams.get('dataset_id')) && state.datasets.some(d => d.dataset_id === c.dataset_id && !d.deleted_at)) }
  else if (p === '/batches' && method === 'POST') result = await createBatch(body)
  else if (p === '/batches/manage' && method === 'POST') { if (!['pin', 'unpin', 'delete', 'restore'].includes(body.action) || !Array.isArray(body.batch_ids)) throw new Error('批次操作不支持'); const selected = body.batch_ids.map((id: string) => state.batches.find(b => b.batch_id === id)); if (selected.some((b: Row) => !b || !clinicalIds(b).length || (body.action === 'delete' && batchView(b).finished < b.run_ids.length))) throw new Error('批次不存在或仍在执行'); for (const b of selected) { if (['pin', 'unpin'].includes(body.action)) b.pinned = +(body.action === 'pin'); else b.deleted_at = body.action === 'delete' ? stamp() : null } await save(); result = { updated: selected.length } }
  else if (p === '/batches') result = list([...state.batches].sort((a, b) => b.pinned - a.pinned).map(batchView).filter(b => b.total > 0))
  else if (p.startsWith('/batches/')) {
    const b = state.batches.find(x => x.batch_id === p.split('/')[2]); if (!b || !clinicalIds(b).length) throw new Error('批次不存在')
    if (p.endsWith('/retry-selected') && method === 'POST') { const rows: Row[] = body.run_ids.map((id: string) => state.runs[id]); if (!rows.length || rows.some(r => !r || r.case.agent !== 'clinical' || r.batch_id !== b.batch_id || ['queued', 'running'].includes(r.status)) || new Set(rows.map(r => r.agent_id)).size !== 1 || new Set(rows.map(r => r.dataset_id)).size !== 1) throw new Error('请选择同一 Agent 和测试集的已结束记录'); result = await createBatch({ agent_id: rows[0].agent_id, dataset_id: rows[0].dataset_id, case_ids: rows.map(r => r.case_id), label: `${b.label} · 重跑` }, Object.fromEntries(rows.map(r => [r.case_id, r.run_id]))) }
    else if (p.endsWith('/report')) { const dimensions: Row = {}, critical: Row[] = []; for (const id of clinicalIds(b)) for (const v of state.runs[id].verdicts) { const counts = dimensions[v.dimension] ||= { pass: 0, fail: 0, unjudged: 0 }; counts[v.result]++; if (v.critical && v.result === 'fail') critical.push({ run_id: id, ...v }) } result = { ...batchView(b), dimensions, critical_failures: critical, clinical_validation: 'not_performed' } }
    else if (p.endsWith('/failures')) { const dim = url.searchParams.get('dimension'), q = (url.searchParams.get('q') || '').toLowerCase(), critical = url.searchParams.get('critical') === 'true'; const rows = clinicalIds(b).flatMap((id: string) => { const r = state.runs[id], findings = r.verdicts.filter((v: Row) => v.result === 'fail' && (!dim || (dim === 'context_all' ? v.dimension.startsWith('context') : v.dimension === dim)) && (!critical || v.critical)); if (!findings.length) return []; const value = { ...r, title: r.case.title, message: r.case.message, findings, critical: findings.some((v: Row) => v.critical) }; return JSON.stringify(value).toLowerCase().includes(q) ? [value] : [] }); result = { items: rows, assertion_count: rows.reduce((n: number, r: Row) => n + r.findings.length, 0) } }
    else result = batchView(b)
  }
  else if (p.startsWith('/runs/')) {
    const r = state.runs[p.split('/')[2]]; if (!r || r.case.agent !== 'clinical') throw new Error('记录不存在')
    if (p.endsWith('/retry') && method === 'POST') { const b = await createBatch({ agent_id: r.agent_id, dataset_id: r.dataset_id, case_ids: [r.case_id], label: '个人评测重跑' }, { [r.case_id]: r.run_id }); result = state.runs[b.runs[0].run_id] }
    else if (p.endsWith('/cancel') && method === 'POST') { if (r.status !== 'queued') throw new Error('仅排队记录可单独取消'); r.status = 'cancelled'; r.finished_at = stamp(); addEvent(r, 'runner.cancelled', 'cancelled', { message: '用户取消排队记录' }); evaluate(r); await save(); result = r }
    else if (p.endsWith('/review') && method === 'POST') { if (!body.reviewer?.trim() || !body.rationale?.trim() || !['pass', 'fail', 'unjudged'].includes(body.result)) throw new Error('请填写复核人和依据'); r.verdicts.push({ ...body, evaluator: 'human', critical: 0, evidence: [`run:${r.run_id}`] }); await save(); result = { items: r.verdicts } }
    else result = r
  }
  else if (p === '/compare') { const left = state.runs[url.searchParams.get('left') || ''], right = state.runs[url.searchParams.get('right') || '']; if (left?.case.agent !== 'clinical' || right?.case.agent !== 'clinical') throw new Error('记录不存在'); result = { comparable: false, reason: '业务接口未返回完整版本指纹，仅供人工对照', left: { run: left }, right: { run: right } } }
  else throw new Error('此工作区操作不支持')
  return structuredClone(result) as T
}
export async function exportPersonalWorkspace() {
  const exportRecords = async () => { await init(); if (!active) state = await readState(); return JSON.stringify({ format: 'agent-evo-personal-v1', exported_at: stamp(), datasets: state.datasets.filter(d => ['clinical','generic'].includes(d.profile)), cases: state.cases.filter(c => ['clinical','generic'].includes(c.agent)), batches: state.batches.filter(b => clinicalIds(b).length).map(b => ({ ...b, run_ids: clinicalIds(b) })), runs: Object.fromEntries(Object.entries(state.runs).filter(([, r]) => r.case.agent === 'clinical')), assignments: { agent_clinical: state.assignments.agent_clinical || [] } }, null, 2) }
  return locks() ? locks()!.request('agent-evo-personal-data', exportRecords) : exportRecords()
}
