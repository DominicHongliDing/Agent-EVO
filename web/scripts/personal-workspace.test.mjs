import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { IDBFactory } from 'fake-indexeddb'

const { outputFiles } = await build({ entryPoints: ['src/personalWorkspace.ts'], bundle: true, write: false, format: 'esm', target: 'es2022' })
let serial = 0
async function workspace(fetcher, factory = new IDBFactory()) {
  globalThis.indexedDB = factory
  globalThis.document = { documentElement: { dataset: {} } }
  globalThis.location = { origin: 'https://example.test', search: '?space=mine' }
  globalThis.fetch = fetcher || (async () => { throw new Error('No business request expected') })
  return import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text + `\n// instance ${serial++}`).toString('base64'))
}
const draft = (cases, profile = 'clinical') => ({ name: '工程验收用例', profile, version: 'v1', filename: 'cases.json', content: JSON.stringify(cases) })
const caseRow = { case_id: 'sleep_correction', message: '最近两周睡不好。', synthetic: true, turns: [{ message: '最近两周睡不好。' }, { message: '更正为三天，请重新整理。', checks: [{ dimension: 'context_correction', title: '采用更正后时间', must_include_any: ['三天'] }] }] }
const post = data => ({ method: 'POST', body: JSON.stringify(data) })
async function finished(api, batch) {
  for (let i = 0; i < 100; i++) { const value = await api(`/batches/${batch.batch_id}`); if (value.finished === value.total) return value; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('Batch did not finish')
}

test('fixed agents, validated upload, allocation and recoverable delete', async () => {
  const w = await workspace(), api = w.personalRequest
  assert.deepEqual((await api('/agents')).items.map(a => a.agent_id), ['agent_clinical'])
  assert.equal(w.previewPersonalDataset(draft([caseRow], 'unihr')).valid, false)
  await assert.rejects(api('/agents', post({ name: 'extra' })), /暂停/)
  const malformed = w.previewPersonalDataset({ ...draft([]), filename: 'bad.jsonl', content: '{broken}\n' })
  assert.equal(malformed.valid, false); assert.ok(malformed.errors.some(e => e.line === 1))
  assert.equal(w.previewPersonalDataset(draft([{ ...caseRow, api_key: 'placeholder' }])).valid, false)
  assert.equal(w.previewPersonalDataset(draft([{ ...caseRow, turns: Array.from({ length: 9 }, () => ({ message: caseRow.message })) }])).valid, false)
  const dataset = await api('/datasets', post(draft([caseRow])))
  assert.ok((await api('/agents')).items.find(a => a.agent_id === 'agent_clinical').dataset_ids.includes(dataset.dataset_id))
  await api(`/datasets/${dataset.dataset_id}/delete`, post({})); assert.ok(!(await api('/datasets')).items.some(d => d.dataset_id === dataset.dataset_id))
  await api(`/datasets/${dataset.dataset_id}/restore`, post({})); assert.ok((await api('/datasets')).items.some(d => d.dataset_id === dataset.dataset_id))
})

test('existing mixed browser history exposes only Clinical and keeps HR evidence offline', async () => {
  const factory = new IDBFactory()
  const database = await new Promise(resolve => { const r = factory.open('agent-evo-personal-v1', 1); r.onupgradeneeded = () => r.result.createObjectStore('workspace'); r.onsuccess = () => resolve(r.result) })
  const old = { datasets: [{dataset_id:'c',profile:'clinical'},{dataset_id:'h',profile:'unihr'}], cases: [{case_id:'c',agent:'clinical',dataset_id:'c'},{case_id:'h',agent:'unihr',dataset_id:'h'}], assignments:{agent_clinical:['c'],agent_unihr:['h']}, batches:[{batch_id:'mixed',label:'双 Agent',run_ids:['rc','rh'],pinned:0},{batch_id:'hr',label:'HR',run_ids:['rh'],pinned:0}], runs:{rc:{run_id:'rc',case_id:'c',case:{agent:'clinical',title:'睡眠'},status:'completed',verdicts:[]},rh:{run_id:'rh',case_id:'h',case:{agent:'unihr',title:'HR archive'},status:'completed',verdicts:[]}} }
  await new Promise(resolve => { const tx=database.transaction('workspace','readwrite'); tx.objectStore('workspace').put(old,'mine'); tx.oncomplete=resolve })
  database.close()
  const w=await workspace(undefined,factory), api=w.personalRequest
  assert.deepEqual((await api('/datasets')).items.map(d=>d.profile),['clinical'])
  assert.deepEqual((await api('/cases')).items.map(c=>c.agent),['clinical'])
  const batch=(await api('/batches')).items
  assert.equal(batch.length,1);assert.equal(batch[0].total,1);assert.equal(batch[0].finished,1)
  assert.deepEqual(batch[0].run_ids,['rc'])
  await assert.rejects(api('/runs/rh'),/记录不存在/)
  await assert.rejects(api('/batches/hr'),/批次不存在/)
  await assert.rejects(api('/compare?left=rc&right=rh'),/记录不存在/)
  assert.ok(!(await w.exportPersonalWorkspace()).includes('HR archive'))
  const stored=await new Promise(resolve=>{ const r=factory.open('agent-evo-personal-v1',1);r.onsuccess=()=>{const q=r.result.transaction('workspace').objectStore('workspace').get('mine');q.onsuccess=()=>{resolve(q.result);r.result.close()}} })
  assert.equal(stored.runs.rh.case.title,'HR archive')
})

test('real orchestration contract: isolated session, two sequential turns, raw events, context failure, no credentials persisted', async () => {
  const calls = [], key = 'engineering-placeholder-key', token = 'engineering-session-secret'
  const w = await workspace(async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {}
    calls.push({ url, method: options.method, body, auth: options.headers?.Authorization })
    if (url.endsWith('/sessions')) return Response.json(options.method === 'DELETE' ? { status: 'deleted' } : { token })
    assert.ok(url.endsWith('/runs')); assert.equal(body.key, key); assert.equal(options.headers.Authorization, `Bearer ${token}`)
    return new Response(JSON.stringify({ node: 'model', status: 'completed', summary: '工程夹具模型步骤' }) + '\n' + JSON.stringify({ node: 'run', status: 'needs_review', answer: '仍然按两周整理，需进一步补充信息。', sources: [] }) + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } })
  })
  const api = w.personalRequest, ds = await api('/datasets', post(draft([caseRow]))), row = (await api('/cases')).items.find(c => c.dataset_id === ds.dataset_id)
  await assert.rejects(api('/batches', post({ agent_id: 'agent_clinical', dataset_id: ds.dataset_id, case_ids: [row.case_id] })), /API Key/)
  w.setConnection({ provider: 'bailian', model: 'qwen-plus', key })
  const b = await api('/batches', post({ agent_id: 'agent_clinical', dataset_id: ds.dataset_id, case_ids: [row.case_id] })); await finished(api, b)
  const run = await api(`/runs/${b.runs[0].run_id}`)
  assert.equal(run.status, 'completed'); assert.equal(run.output.conversation_turns.length, 2)
  assert.equal(run.output.conversation_turns[0].conversation_id, run.output.conversation_turns[1].conversation_id)
  assert.equal(calls.filter(c => c.url.endsWith('/sessions') && c.method === 'POST').length, 1)
  assert.equal(calls.filter(c => c.url.endsWith('/runs')).length, 2)
  assert.ok(run.verdicts.some(v => v.dimension === 'context_correction' && v.result === 'fail'))
  assert.equal(run.model_calls, 0); assert.equal(run.live_model_verified, false)
  const exported = await w.exportPersonalWorkspace(); assert.ok(!exported.includes(key)); assert.ok(!exported.includes(token))
  const failures = await api(`/batches/${b.batch_id}/failures?dimension=context_all`); assert.equal(failures.items.length, 1)
  await api('/batches/manage', post({ batch_ids: [b.batch_id], action: 'pin' })); assert.equal((await api('/batches')).items[0].pinned, 1)
})

test('malformed NDJSON preserves earlier event, fails the precise turn and prevents later turns', async () => {
  let requests = 0
  const w = await workspace(async (url, options = {}) => {
    if (url.endsWith('/sessions')) return Response.json(options.method === 'DELETE' ? {} : { token: 'test-session-token' })
    requests++; return new Response('{"node":"knowledge_retrieval","status":"completed","sources":[]}\nnot-json\n', { headers: { 'Content-Type': 'application/x-ndjson' } })
  })
  const api = w.personalRequest, ds = await api('/datasets', post(draft([caseRow]))), row = (await api('/cases')).items.find(c => c.dataset_id === ds.dataset_id)
  w.setConnection({ provider: 'bailian', model: 'qwen-plus', key: 'engineering-placeholder-key' })
  const b = await api('/batches', post({ agent_id: 'agent_clinical', dataset_id: ds.dataset_id, case_ids: [row.case_id] })); await finished(api, b)
  const run = await api(`/runs/${b.runs[0].run_id}`)
  assert.equal(requests, 1); assert.equal(run.status, 'failed'); assert.equal(run.output.conversation_turns[0].status, 'failed')
  assert.ok(run.events.some(e => e.node === 'knowledge_retrieval')); assert.ok(run.events.some(e => String(e.payload.message).includes('有效 JSON')))
  assert.ok(run.verdicts.some(v => v.dimension === 'business_node' && v.result === 'fail'))
})

test('custom targets and mismatched datasets cannot execute or leak a Key', async () => {
  const w = await workspace(), api = w.personalRequest
  await api('/agents'); w.setConnection({ provider: 'bailian', model: 'qwen-plus', key: 'engineering-placeholder-key' })
  await assert.rejects(api('/batches', post({ agent_id: 'custom', dataset_id: 'x', case_ids: ['x'] })), /仅允许/)
  const ds = (await api('/datasets')).items.find(d => d.profile === 'clinical')
  await assert.rejects(api('/batches', post({ agent_id: 'agent_unihr', dataset_id: ds.dataset_id, case_ids: ['x'] })), /仅允许/)
  await assert.rejects(api('/batches', post({ agent_id: 'agent_clinical', dataset_id: 'missing', case_ids: ['x'] })), /未分配/)
  assert.ok(!(await w.exportPersonalWorkspace()).includes('engineering-placeholder-key'))
})

test('stop aborts the active request, cancels queued cases and does not send later turns', async () => {
  let requests = 0, began
  const started = new Promise(resolve => { began = resolve })
  const w = await workspace(async (url, options = {}) => {
    if (url.endsWith('/sessions')) return Response.json(options.method === 'DELETE' ? {} : { token: 'stop-session' })
    requests++; began()
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }))
  })
  const api = w.personalRequest, ds = await api('/datasets', post(draft([caseRow, { ...caseRow, case_id: 'queued_case' }])))
  const rows = (await api('/cases')).items.filter(c => c.dataset_id === ds.dataset_id)
  w.setConnection({ provider: 'bailian', model: 'qwen-plus', key: 'engineering-placeholder-key' })
  const b = await api('/batches', post({ agent_id: 'agent_clinical', dataset_id: ds.dataset_id, case_ids: rows.map(c => c.case_id) }))
  await started; w.stopPersonalBatch(); const done = await finished(api, b)
  assert.equal(requests, 1); assert.ok(done.runs.every(r => r.status === 'cancelled'))
  assert.ok((await api(`/runs/${done.runs[1].run_id}`)).events.some(e => e.node === 'runner.cancelled'))
})

test('reopening interrupts stale execution without storing credentials or auto retry', async () => {
  const factory = new IDBFactory(), w = await workspace(undefined, factory), api = w.personalRequest
  await api('/agents'); const data = JSON.parse(await w.exportPersonalWorkspace())
  const c = data.cases[0], id = 'run_interrupted'
  data.runs[id] = { run_id: id, status: 'running', case: c, events: [], verdicts: [] }
  data.batches = [{ batch_id: 'batch_interrupted', run_ids: [id] }]
  const db = await new Promise(resolve => { const req = factory.open('agent-evo-personal-v1'); req.onsuccess = () => resolve(req.result) })
  await new Promise(resolve => { const tx = db.transaction('workspace', 'readwrite'); tx.objectStore('workspace').put(data, 'mine'); tx.oncomplete = resolve }); db.close()
  const restored = await workspace(undefined, factory), run = await restored.personalRequest(`/runs/${id}`)
  assert.equal(restored.connectionSummary(), null); assert.equal(run.status, 'cancelled'); assert.equal(run.error_code, 'page_interrupted')
  assert.ok(run.events.some(e => e.node === 'runner.interrupted'))
})

test('failure diagnosis points to the failed business step, and credential echoes are never persisted', async () => {
  const key = 'engineering-sensitive-placeholder'
  const w = await workspace(async (url, options = {}) => {
    if (url.endsWith('/sessions')) return Response.json(options.method === 'DELETE' ? {} : { token: 'failure-session' })
    return new Response('{"node":"knowledge_retrieval","status":"failed","summary":"材料召回失败"}\n', { headers: { 'Content-Type': 'application/x-ndjson' } })
  })
  const api = w.personalRequest, ds = (await api('/datasets')).items.find(d => d.profile === 'clinical'), row = (await api('/cases')).items.find(c => c.dataset_id === ds.dataset_id)
  w.setConnection({ provider: 'bailian', model: 'qwen-plus', key })
  const b = await api('/batches', post({ agent_id: 'agent_clinical', dataset_id: ds.dataset_id, case_ids: [row.case_id] })); await finished(api, b)
  const run = await api(`/runs/${b.runs[0].run_id}`)
  assert.match(run.verdicts.find(v => v.dimension === 'business_node').rationale, /knowledge_retrieval/)
  globalThis.fetch = async (url, options = {}) => url.endsWith('/sessions') ? Response.json(options.method === 'DELETE' ? {} : { token: 'echo-session' }) : new Response(JSON.stringify({ node: 'run', answer: key }) + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } })
  const echo = await api('/batches', post({ agent_id: 'agent_clinical', dataset_id: ds.dataset_id, case_ids: [row.case_id] })); await finished(api, echo)
  assert.equal((await api(`/runs/${echo.runs[0].run_id}`)).status, 'failed'); assert.ok(!(await w.exportPersonalWorkspace()).includes(key))
})
