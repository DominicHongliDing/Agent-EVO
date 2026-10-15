import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/replayPresentation.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
const { answerParts, replaySteps, replaySources, eventTitle } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const event = (seq, kind, node, payload, status = 'completed') => ({ seq, kind, node, payload, status, created_at: '2026-10-09T11:00:00Z' })

test('timeline names platform events and decodes the actual business action inside step', () => {
  assert.equal(eventTitle(event(1, 'runner', 'runner.claim', {})), '安排执行任务')
  assert.equal(eventTitle(event(2, 'runner', 'runner.start', {})), '开始执行评测')
  assert.equal(eventTitle(event(3, 'recording', 'recording.import', {})), '导入已有对话记录')
  assert.equal(eventTitle(event(4, 'business_event', 'step', {step_id: 'intent_routing'})), '识别意图与路由')
  assert.equal(eventTitle(event(5, 'business_event', 'step', {step_id: 'evidence_retrieval'})), '检索临床资料')
})
test('unknown actions preserve recorded human titles and never invent an action', () => {
  assert.equal(eventTitle(event(1, 'business_event', 'step', {title: '核对本轮材料'})), '核对本轮材料')
  assert.equal(eventTitle(event(2, 'business_event', 'not_known', {title: 'Do Something'})), '其他已记录动作')
  assert.equal(eventTitle(event(3, 'business_event', 'step', {})), '其他已记录动作')
})
test('business descriptions translate transport enums without altering raw evidence', () => {
  const raw = {type:'step',step_id:'draft_generation',detail:'已生成草稿，生成模式：clarification_required。'}
  const run = {case:{agent:'clinical'},events:[event(1,'business_event','step',raw)]}
  assert.equal(replaySteps(run)[0].description,'已生成草稿，生成模式：需要补充信息。')
  assert.equal(raw.detail,'已生成草稿，生成模式：clarification_required。')
})

test('UniHR displays the exact assistant body without serializing the message object', () => {
  const content = '**证据不足**，请人工核验。\n\n[E1]'
  assert.deepEqual(answerParts({ output: { result: { assistant_message: { content, role: 'assistant', trace: [] } } } }), [{ title: '', content }])
})
test('Clinical deduplicates a repeated summary and retains the claim review text', () => {
  const run = { output: { result: { answer: { summary: '来源冲突，不能形成确定结论。', sections: [
    { title: '模型输出', content: '来源冲突，不能形成确定结论。' }, { title: '审核', content: '已移除无依据主张。' },
  ] } } } }
  assert.deepEqual(answerParts(run), [{ title: '', content: '来源冲突，不能形成确定结论。' }, { title: '审核', content: '已移除无依据主张。' }])
})
test('absent or unsupported response shapes never fabricate an answer or a JSON body', () => {
  assert.deepEqual(answerParts({ status: 'running' }), [])
  assert.deepEqual(answerParts({ output: { result: { answer: { unexpected: 'not a supported body' } } } }), [])
})
test('UniHR ignores duplicate transport copies and preserves separate retrieval attempts', () => {
  const first = { summary: '第 1 轮得到 3 个片段', status: 'completed', attempt: 1 }
  const second = { summary: '第 2 轮得到 4 个片段', status: 'completed', attempt: 2 }
  const run = { case: { agent: 'unihr' }, events: [
    event(1, 'business_event', 'tool.policy.retrieve.completed', first),
    event(2, 'business_step', 'knowledge.retrieve', { ...first, details: { attempt: 1 } }),
    event(3, 'business_step', 'knowledge.retrieve', { ...second, details: { attempt: 2 } }),
    event(4, 'business_trace', 'knowledge.retrieve', first), event(5, 'business_trace', 'knowledge.retrieve', second),
  ] }
  assert.deepEqual(replaySteps(run).map(row => row.description), [first.summary, second.summary])
})
test('Clinical matches skipped semantic steps to persistent nodes and keeps both retrieval rounds', () => {
  const run = { case: { agent: 'clinical' }, events: [
    event(1, 'business_event', 'step', { type: 'step', step_id: 'query_rewrite', status: 'skipped', detail: '未使用上下文。' }),
    event(2, 'business_event', 'step', { type: 'step', step_id: 'evidence_retrieval', status: 'completed', detail: '第一次检索。' }),
    event(3, 'business_event', 'step', { type: 'step', step_id: 'evidence_retrieval', status: 'completed', detail: '补充检索。' }),
    event(4, 'business_step', 'rewrite_clinical_query', {}), event(5, 'business_step', 'execute_tools', {}), event(6, 'business_step', 'execute_tools', {}),
  ] }
  const rows = replaySteps(run)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].status, 'skipped')
  assert.deepEqual(rows.slice(1).map(row => row.description), ['第一次检索。', '补充检索。'])
})
test('running Clinical records present observed stream steps and preserve failures', () => {
  const run = { status: 'running', case: { agent: 'clinical' }, events: [
    event(1, 'business_event', 'step', { type: 'step', step_id: 'case_parse', title: '病例解析', status: 'completed', detail: '已接收问题。' }),
    event(2, 'business_event', 'step', { type: 'step', step_id: 'evidence_retrieval', status: 'failed', detail: '检索连接失败。' }),
  ] }
  const rows = replaySteps(run)
  assert.equal(rows.length, 2)
  assert.equal(rows[1].status, 'failed')
  assert.equal(rows[1].description, '检索连接失败。')
})
test('citations keep different chunks from the same document and remove only duplicate chunks', () => {
  const source = { document_title: '合成指南', source_id: 'synthetic-guide', evidence_snippet: '合成片段' }
  const run = { case: { agent: 'clinical' }, output: { result: { citations: [
    { ...source, chunk_id: 'chunk-1' }, { ...source, chunk_id: 'chunk-2' }, { ...source, chunk_id: 'chunk-1' },
  ] } } }
  assert.deepEqual(replaySources(run).map(row => row.key), ['chunk-1', 'chunk-2'])
})
test('UniHR preserves source references and version from the captured business evidence', () => {
  const run = { case: { agent: 'unihr' }, events: [event(1, 'business_step', 'evidence.sources', { details: { sources: [
    { source_id: 'synthetic-policy', reference_id: 'E7', title: '合成政策', citation: '第 2 页', source_version: 'v2' },
  ] } })] }
  const [source] = replaySources(run)
  assert.equal(source.reference, 'E7')
  assert.equal(source.version, 'v2')
  assert.equal(source.excerpt, '第 2 页')
})
test('business step timestamps take precedence over the later platform collection time', () => {
  const sourceTime = '2026-10-09T10:58:00Z'
  const run = { case: { agent: 'clinical' }, events: [event(1, 'business_step', 'plan_task', { created_at: sourceTime, payload: {} })] }
  assert.equal(replaySteps(run)[0].time, sourceTime)
})
