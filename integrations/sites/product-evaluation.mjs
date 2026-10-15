// Retain the existing two product presentations; add a peer with the actual UI.
// The supplied Site has a compiled portfolio, so we use its parsed component ranges.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createHash } from 'node:crypto'
const require = createRequire(new URL('../../web/package.json', import.meta.url))
const { parse } = require('@babel/parser')
const checkout = process.argv[2]
if (!checkout) throw new Error('Pass the already opened Site checkout')
const file = path.join(checkout, 'public/assets/Portfolio-BFLWY-66.js')
let source = fs.readFileSync(file, 'utf8')
if (!source.includes('clinical-evaluation-product')) {
  const ast = parse(source, { sourceType: 'module' })
  const component = ast.program.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === '_')
  const returned = component.body.body.find(n => n.type === 'ReturnStatement').argument
  const track = returned.arguments[3].arguments[2]
  const slide0 = source.slice(track.arguments[2].start, track.arguments[2].end)
  const slide1 = source.slice(track.arguments[3].start, track.arguments[3].end)
  const replacement = `function _() {
    const [t,a] = s.useState(0), n = s.useRef(null);
    const labels = ['UniHR AgentOS','SuperCare AI','Agent 评测平台'];
    const move = direction => a(current => Math.max(0,Math.min(2,current+direction)));
    return e.createElement('section',{className:'wrap product-carousel',id:'products','aria-label':'产品体验','aria-roledescription':'轮播'},
      e.createElement('div',{className:'product-switch',role:'group','aria-label':'选择产品'},labels.map((label,index)=>e.createElement('button',{key:label,'aria-pressed':t===index,onClick:()=>a(index)},label))),
      e.createElement('div',{className:'product-viewport',tabIndex:0,'aria-label':'使用左右方向键切换产品',onKeyDown:event=>{if(event.target!==event.currentTarget)return;if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();move(event.key==='ArrowRight'?1:-1)}},onTouchStart:event=>{n.current=[event.touches[0].clientX,event.touches[0].clientY]},onTouchEnd:event=>{if(!n.current)return;const dx=event.changedTouches[0].clientX-n.current[0],dy=event.changedTouches[0].clientY-n.current[1];if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy))move(dx<0?1:-1);n.current=null}},
        t===2 ? e.createElement('article',{className:'clinical-evaluation-product'},
          e.createElement('div',{className:'evaluation-product-heading'},e.createElement('div',null,e.createElement('span',{className:'eyebrow'},'03 / AGENT EVO'),e.createElement('h2',null,'从每次回答，看到每一步'),e.createElement('p',null,'Clinical 本地已完成 50 条真实模型评测。直接浏览完整平台、失败诊断与多轮上下文记录。')),
            e.createElement('a',{className:'button secondary',href:'/apps/evaluation/index.html'},'打开完整评测平台 ',e.createElement(i,{size:17}))),
          e.createElement('iframe',{title:'Agent EVO 完整 Clinical 评测平台',src:'/apps/evaluation/index.html?view=batches&embed=1',loading:'lazy',className:'evaluation-product-frame'}))
        : e.createElement('div',{className:'product-track',style:{transform:\`translateX(-\${t*100}%)\`}},${slide0},${slide1})),
      e.createElement('div',{className:'product-bottom'},e.createElement('span',{'aria-live':'polite'},['意图 → Skill → 执行 → 验收','上下文 → 证据 → 答案核验 → 医生复核','输入 → 逐步证据 → 质量诊断 → 本地受控重跑'][t]),
        e.createElement('div',{className:'carousel-controls'},e.createElement('span',null,'0',t+1,' / 03'),e.createElement('button',{'aria-label':'上一个产品',disabled:t===0,onClick:()=>move(-1)},e.createElement(z,{size:18})),e.createElement('button',{'aria-label':'下一个产品',disabled:t===2,onClick:()=>move(1)},e.createElement(E,{size:18})))),
      t===2 ? e.createElement('section',{className:'project-brief'},e.createElement('div',{className:'project-brief-heading'},e.createElement('span',null,'本地闭环 · 公开证据'),e.createElement('h3',null,'一个可以追到具体步骤的 Agent 评测平台'),e.createElement('p',{className:'project-goal'},'同一套前端连接本地 FastAPI Runner、SQLite 与真实 Clinical 业务后端；保存意图、上下文、检索、回答核验和模型用量，再将选定的合成记录发布到这里。')),
        e.createElement('div',{className:'project-brief-grid'},[['完整交互','直接操作真实 UI','测试集、批次、失败筛选、节点时间线、可读回放与原始输出均可查看。'],['真实记录','50 条主批次 + 多轮实例','177 次主批次真实业务模型调用，实际失败与待判断均保留；多轮记录单独计数。'],['本地调试','用证据定位上下文偏差','比如将两周更正为三天，查看后续回答是否采用新事实；在本地受控重跑并复核。']].map(([label,title,text])=>e.createElement('article',{key:label},e.createElement('span',null,label),e.createElement('h4',null,title),e.createElement('p',null,text)))),
        e.createElement('p',{className:'project-scope'},'公开页面仅展示 Clinical 合成场景的已保存记录，线上浏览不调用模型。新增评测与管理写入在本地执行。工程结果与医生临床验证分别记录。'))
        : e.createElement(U,{kind:t===0?'unihr':'clinical'}));
  }`
  source = source.slice(0, component.start) + replacement + source.slice(component.end)
  // Add the entry to the existing right-hand product buttons without a fixed overlay.
  const updated = parse(source, { sourceType: 'module' })
  let hero
  const visit = node => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'CallExpression' && node.arguments?.[1]?.type === 'ObjectExpression' &&
        node.arguments[1].properties.some(p=>p.key?.name==='className' && p.value?.value==='hero-actions')) hero=node
    for (const [key,value] of Object.entries(node)) {
      if (['start','end','loc'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value==='object') visit(value)
    }
  }
  visit(updated.program)
  if (!hero) throw new Error('The existing right-side product actions were not found')
  source=source.slice(0,hero.end-1)+`, e.createElement('a',{className:'button secondary evaluation-entry',href:'/apps/evaluation/index.html'},'Agent 评测平台 ',e.createElement(i,{size:17}))`+source.slice(hero.end-1)
  parse(source,{sourceType:'module'})
  fs.writeFileSync(file,source)
}
// Update retained compiled portfolios on subsequent publishes as well.
for (const [before, after] of [
  ['Clinical 本地已完成 50 条真实模型评测。直接浏览完整平台、失败诊断与多轮上下文记录。', '上传自己的测试集，用 API Key 评测 UniHR 与 Clinical，逐轮查看回答和执行步骤；也可浏览 50 条 Clinical 历史评测。'],
  ['Agent EVO 完整 Clinical 评测平台', 'Agent EVO 双 Agent 评测平台'],
  ['/apps/evaluation/index.html?view=batches&embed=1', '/apps/evaluation/index.html?space=mine&view=agents&embed=1'],
  ['输入 → 逐步证据 → 质量诊断 → 本地受控重跑', '上传测试集 → 选择双 Agent → 逐轮执行 → 证据回放'],
  ['本地闭环 · 公开证据', '双 Agent 自助评测 · Clinical 历史证据'],
  ['同一套前端连接本地 FastAPI Runner、SQLite 与真实 Clinical 业务后端；保存意图、上下文、检索、回答核验和模型用量，再将选定的合成记录发布到这里。', '官网和本地共用评测前端。访客自带 API Key 调用现有双 Agent 业务服务，测试集与逐轮证据存于自己的浏览器；本地完整原生链路另保留 SQLite、业务 Run ID 和用量核验。'],
  ['测试集、批次、失败筛选、节点时间线、可读回放与原始输出均可查看。', '上传测试集并分配给预置 Agent，执行多轮用例、整理批次、定位失败；可读回放和原始事件并存。'],
  ['公开页面仅展示 Clinical 合成场景的已保存记录，线上浏览不调用模型。新增评测与管理写入在本地执行。工程结果与医生临床验证分别记录。', '新增 Agent 暂未开放。历史公开记录只含 Clinical 合成场景；访客工作区不会自动公开数据。当前访客接口未返回模型用量，逐轮执行记录标为用量未核验。工程评测与医生临床验证分别记录。']
]) source = source.replaceAll(before, after)
for (const [before, after] of [
  ['上传自己的测试集，用 API Key 评测 UniHR 与 Clinical，逐轮查看回答和执行步骤；也可浏览 50 条 Clinical 历史评测。', '上传已有问答直接评审，或选择测试集运行 Clinical。逐轮查看回答与依据，把发现的问题留下来持续验证。'],
  ['Agent EVO 双 Agent 评测平台', 'Agent EVO 回答评审与 Clinical 评测平台'],
  ['/apps/evaluation/index.html?space=mine&view=agents&embed=1', '/apps/evaluation/index.html?space=mine&view=evaluate&embed=1'],
  ['/apps/evaluation/index.html?space=history&view=story&embed=1', '/apps/evaluation/index.html?space=mine&view=evaluate&embed=1'],
  ['上传测试集 → 选择双 Agent → 逐轮执行 → 证据回放', '导入回答 → 查看依据 → 保存测试题 → 持续验证'],
  ['双 Agent 自助评测 · Clinical 历史证据', '回答评审 · 测试集回归 · Clinical 示例'],
  ['官网和本地共用评测前端。访客自带 API Key 调用现有双 Agent 业务服务，测试集与逐轮证据存于自己的浏览器；本地完整原生链路另保留 SQLite、业务 Run ID 和用量核验。', '从现成问答开始，上传 Excel、CSV 或对话文件即可查看质量；确认改进期望后保存为测试集，再验证新的回答。记录保存在自己的浏览器，评分使用自己的百炼 Key。'],
  ['上传测试集并分配给预置 Agent，执行多轮用例、整理批次、定位失败；可读回放和原始事件并存。', '双入口分别面向已有回答和新运行。完整对话、评分引用、同题对比与原始资料按需展开。'],
  ['新增 Agent 暂未开放。历史公开记录只含 Clinical 合成场景；访客工作区不会自动公开数据。当前访客接口未返回模型用量，逐轮执行记录标为用量未核验。工程评测与医生临床验证分别记录。', '仅内置 Clinical。上传材料与结果保存在当前浏览器，不会自动公开；问答评分经本站转发至百炼。自定义脚本在本地执行。历史证据只含合成场景；医生临床验证另行开展。']
]) source = source.replaceAll(before, after)
parse(source, { sourceType: 'module' })
fs.writeFileSync(file, source)
const css = path.join(checkout,'public/assets/evaluation-entry.css')
fs.writeFileSync(css,`
.hero-actions{flex-wrap:wrap;justify-content:flex-start;gap:10px}.hero-actions .button{padding:14px 20px;font-size:13px}.product-switch{flex-wrap:wrap}.clinical-evaluation-product{background:#fff;border:1px solid #dce5ef;border-radius:24px;overflow:hidden}.evaluation-product-heading{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:28px 32px}.evaluation-product-heading h2{font-size:28px;margin:10px 0}.evaluation-product-heading p{font-size:13px;line-height:1.8;max-width:650px;color:#667487;margin:0}.evaluation-product-heading .button{flex:none;font-size:12px}.evaluation-product-frame{display:block;width:100%;height:900px;border:0;border-top:1px solid #e0e8ed;background:#f5f8f5}.evaluation-entry{border-color:#b9cde5!important}
@media(max-width:760px){.hero-actions{justify-content:center}.hero-actions .button{padding:12px 16px;font-size:12px}.product-switch button{padding:10px 15px;font-size:12px}.evaluation-product-heading{padding:22px;display:block}.evaluation-product-heading h2{font-size:24px}.evaluation-product-heading .button{margin-top:18px}.evaluation-product-frame{height:1000px}}
`)
const html = path.join(checkout,'public/index.html')
let index=fs.readFileSync(html,'utf8')
if (!index.includes('/assets/evaluation-entry.css')) index=index.replace('</head>','<link rel="stylesheet" href="/assets/evaluation-entry.css"></head>')
fs.writeFileSync(html,index)
// The retained portfolio was supplied as compiled assets. Give the changed
// modules new URLs so an already-open public browser sees the update on reload.
const hash = text => createHash('sha256').update(text).digest('hex').slice(0,12)
const assetsDir=path.join(checkout,'public/assets')
const entryFile=path.join(assetsDir,'index-y0SkDqvt.js')
const originalNames=['index-y0SkDqvt.js','Portfolio-BFLWY-66.js','Architecture-Ch4hk4pR.js']
const prefixes=['index','Portfolio','Architecture']
const canonical=text=>prefixes.reduce((text,prefix,i)=>text.replace(new RegExp(prefix+'-clinical-[a-f0-9]+\\.js','g'),originalNames[i]),text)
const originals=[canonical(fs.readFileSync(entryFile,'utf8')),canonical(source),canonical(fs.readFileSync(path.join(assetsDir,originalNames[2]),'utf8'))]
const revision=hash(originals.join('\n'))
const names=prefixes.map(prefix=>prefix+'-clinical-'+revision+'.js')
for(const old of fs.readdirSync(assetsDir)) if (/^(Portfolio|index|Architecture)-clinical-[a-f0-9]+\.js$/.test(old) && !names.includes(old)) fs.unlinkSync(path.join(assetsDir,old))
// Keep every import in the same module graph, including the shared React entry.
for(let i=0;i<names.length;i++){
  const content=originalNames.reduce((text,old,j)=>text.replaceAll(old,names[j]),originals[i])
  fs.writeFileSync(path.join(assetsDir,names[i]),content)
}
fs.writeFileSync(entryFile,originals[0])
fs.writeFileSync(html,fs.readFileSync(html,'utf8').replace(/\/assets\/index-(?:y0SkDqvt|clinical-[a-f0-9]+)\.js/g,'/assets/'+names[0]))
console.log('Updated the peer product entry with answer review and Clinical dataset evaluation.')
