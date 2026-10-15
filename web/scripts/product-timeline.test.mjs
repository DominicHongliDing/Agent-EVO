import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const modelUrl = dataUrl(compile('../src/productTimelinePresentation.ts'))
const { buildTimeline, stepsFor, statusOf, rowFor, stepFacts } = await import(modelUrl)
const componentSource = compile('../src/ProductTimeline.tsx')
  .replace(/from ['"]react\/jsx-runtime['"]/g, `from '${pathToFileURL(require.resolve('react/jsx-runtime')).href}'`)
  .replace(/from ['"]\.\/productTimelinePresentation['"]/g, `from '${modelUrl}'`)
  .replace(/import ['"]\.\/product-timeline.css['"];?/g, '')
const { default: ProductTimeline } = await import(dataUrl(componentSource))
const event = (seq, kind, node, payload = {}, status = 'completed') => ({ seq, kind, node, payload, status, created_at: '2026-10-09T11:00:00Z' })
const run = events => ({ run_id: 'synthetic-test', status: 'completed', case: { agent: 'clinical', message: '合成测试：查找相关资料' }, events })
const stream = (seq, step_id, metadata, turn_index = 1) => event(seq, 'business_event', 'step', { type: 'step', step_id, metadata, turn_index, status: 'completed' }, 'observed')

test('pair each retrieval occurrence, retain exact evidence and recorded duration', () => {
  const events = [stream(1,'evidence_retrieval',{candidate_count:3}),stream(2,'evidence_retrieval',{candidate_count:8}),
    event(3,'business_step','execute_tools',{latency_ms:42, payload:{selected_tools:['clinical_rag_retriever']}}),event(4,'business_step','execute_tools',{latency_ms:0})]
  const before = JSON.stringify(events)
  const steps = buildTimeline(run(events)).sections[0].steps
  assert.deepEqual(steps.map(s => s.sources.map(e => e.seq)), [[3,1],[4,2]])
  assert.deepEqual(steps.map(s => s.data.candidate_count), [3,8])
  assert.deepEqual(steps.map(s => s.duration), [42,0])
  assert.equal(JSON.stringify(events), before)
  assert.equal(steps[0].title,'检索临床资料')
})

test('multi-turn matching never uses a different turn; unattributed events stay in archive', () => {
  const record = run([stream(1,'evidence_retrieval',{candidate_count:3},1),stream(2,'evidence_retrieval',{candidate_count:7},2),
    event(3,'business_step','execute_tools',{turn_index:2}),event(4,'business_step','execute_tools',{turn_index:1}),event(5,'business_step','execute_tools',{})])
  record.case.turns = [{message:'第一轮'},{message:'第二轮'}]
  const model = buildTimeline(record)
  assert.deepEqual(model.sections.map(t => t.steps.map(s => s.sources.map(e => e.seq))), [[[4,1]],[[3,2]]])
  assert.equal(model.unassigned,1)
  assert.equal(model.events.length,5)
})

test('metadata becomes readable results without treating generated queries as input', () => {
  const e = stream(1,'evidence_query_plan',{rewritten_queries:['合成检索问题一','合成检索问题二']})
  const row = rowFor(e,null,run([e]))
  const facts = stepFacts(row)
  assert.equal(row.description,'整理出 2 个检索问题。')
  assert.deepEqual(facts.input,[])
  assert.deepEqual(facts.output,[['检索的问题','合成检索问题一、合成检索问题二']])
  const zeros=stepFacts(rowFor(stream(2,'unknown',{needs_retrieval:false,evidence_count:0}),null,run([])))
  assert(zeros.output.some(([label,value])=>label==='是否需要查找资料'&&value==='否'))
  assert(zeros.output.some(([label,value])=>label==='资料条数'&&value==='0'))
})

test('unknown, failed and historical start events are not shown as successful or still running', () => {
  const record=run([])
  assert.equal(statusOf('observed',record).label,'已记录')
  assert.equal(statusOf('running',record).label,'当时开始')
  const unknown=rowFor(event(1,'business_event','step',{type:'step',step_id:'unknown'},'observed'),null,record)
  assert.equal(unknown.title,'其他已记录步骤')
  assert.equal(unknown.duration,null)
  const failed=rowFor(event(2,'business_step','execute_tools',{error_message:'合成网络故障'},'failed'),null,record)
  assert.equal(failed.status.tone,'bad')
  assert.deepEqual(stepFacts(failed).errors,[['异常说明','合成网络故障']])
  assert.equal(buildTimeline(record).sections[0].steps.length,0)
})

test('business times determine order and technical summaries stay out of default descriptions', () => {
  const steps=stepsFor([event(1,'business_step','generate_answer',{created_at:'2026-10-09T10:00:03Z',summary:'generate_answer: evidence=3'}),
    event(2,'business_step','plan_task',{created_at:'2026-10-09T10:00:01Z'})],run([]))
  assert.deepEqual(steps.map(s=>s.node),['plan_task','generate_answer'])
  assert.equal(steps[1].description,'已完成回答生成步骤。')
})

test('UniHR prefers canonical trace over copies and generic recorded events stay visible', () => {
  const record={...run([]),case:{agent:'unihr',message:'合成政策问题'}}
  record.events=[event(1,'business_step','knowledge.retrieve',{summary:'传输副本'}),event(2,'business_trace','knowledge.retrieve',{summary:'第一次检索',details:{evidence_count:2}}),event(3,'business_trace','knowledge.retrieve',{summary:'补充检索'})]
  const steps=buildTimeline(record).sections[0].steps
  assert.deepEqual(steps.map(s=>s.description),['第一次检索','补充检索'])
  assert.equal(steps[0].data.evidence_count,2)
  assert.equal(stepsFor([event(4,'business_event','custom.action',{title:'核对合成材料'})],record)[0].title,'核对合成材料')
})

test('render three collapsed levels, labelled raw JSON, and safe text escaping', () => {
  const original=stream(1,'evidence_query_plan',{rewritten_queries:['<script>synthetic</script>']})
  const html=renderToStaticMarkup(createElement(ProductTimeline,{run:run([original])}))
  assert(html.includes('先看做了什么，再看具体依据'))
  assert(html.includes('步骤详情')&&html.includes('原始执行记录'))
  assert(html.includes('aria-label="事件 1 的原始 JSON"'))
  assert(!/<details[^>]*\bopen(?:\s|=|>)/.test(html))
  assert(!html.includes('<script>synthetic</script>'))
  assert(html.includes('&lt;script&gt;synthetic&lt;/script&gt;'))
  const encoded=JSON.stringify(original,null,2).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#x27;')
  assert(html.includes(encoded),'Original evidence is shown without alteration')
})
