import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

// Validate the real exported records, rather than fabricated success responses.
const root = new URL('../../.local/public-clinical/', import.meta.url)
const snapshot = JSON.parse(await readFile(new URL('snapshot.json', root), 'utf8'))
globalThis.document = { documentElement: { dataset: { evoMode: 'clinical-public' } } }
globalThis.location = { origin: 'https://example.test', search: '?space=history' }
let requests = []
globalThis.fetch = async url => {
  requests.push(url)
  const relative = url.replace('/apps/evaluation/', '')
  if (!/^(snapshot\.json|runs\/run_[a-f0-9]+\.json)$/.test(relative)) throw new Error('Unexpected public request')
  return Response.json(JSON.parse(await readFile(new URL(relative, root), 'utf8')))
}
const code = ts.transpile((await readFile(new URL('../src/publicSnapshot.ts', import.meta.url), 'utf8')), { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 })
const { snapshotRequest: api } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))

test('Clinical index contains 50 real main records, with exactly 177 historical calls', async () => {
  const batches = (await api('/batches')).items
  const main = batches.find(b => b.batch_id === snapshot.primary_batch_id)
  assert.equal(main.total, 50)
  assert.equal(main.finished, 50)
  assert.equal(main.runs.reduce((sum,r)=>sum+r.model_calls,0),177)
  assert.ok((await api('/cases')).items.every(c=>c.agent==='clinical' && c.synthetic===true))
  assert.ok((await api('/agents')).items.every(a=>a.adapter_kind==='clinical'))
  assert.equal(requests.length,1)
})
test('Failure filters expose real verdicts, keep unjudged out, and preserve 22 failed assertions', async () => {
  const all = await api(`/batches/${snapshot.primary_batch_id}/failures`)
  assert.equal(all.items.length,17)
  assert.equal(all.assertion_count,22)
  const retrieval = await api(`/batches/${snapshot.primary_batch_id}/failures?dimension=retrieval`)
  assert.equal(retrieval.items.length,3)
  assert.equal(retrieval.assertion_count,3)
  assert.ok(retrieval.items.every(r=>r.findings.every(v=>v.dimension==='retrieval' && v.result==='fail')))
  const safety = await api(`/batches/${snapshot.primary_batch_id}/failures?critical=true`)
  assert.equal(safety.items.length,0)
  const filtered = await api(`/batches/${snapshot.primary_batch_id}/failures?q=${encodeURIComponent(retrieval.items[0].case_id)}`)
  assert.equal(filtered.items.length,1)
})
test('Details are loaded on demand once and retain full outputs, timeline and verdicts', async () => {
  const id = snapshot.batches[0].runs[0].run_id
  const before = requests.length
  const run = await api('/runs/'+id)
  assert.ok(run.output.result)
  assert.ok(run.events.length>0)
  assert.ok(run.verdicts.length>0)
  assert.equal((await api('/runs/'+id)).run_id,id)
  assert.equal(requests.length,before+1)
})
test('All mutation methods and non-public IDs are denied without making a business request', async () => {
  const before = requests.length
  for (const method of ['POST','PATCH','PUT','DELETE']) await assert.rejects(api('/batches', {method}),/本地/)
  await assert.rejects(api('/runs/private'),/未公开/)
  await assert.rejects(api('/batches/private/report'),/未公开/)
  assert.equal(requests.length,before)
})
