import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { decisionFindings, decisionSummary } from './decisionCore.mjs'
type Row=Record<string,any>
export const reportLabels:Record<string,string>={factual:'与参考依据一致',evidence_consistency:'与给定证据一致',coverage:'需求覆盖',relevance:'相关性',context:'上下文遵循',clarity:'表达清晰',assessed:'已完成评审',critical_unjudged:'关键安全待判断',planned:'计划记录',scored:'完整评分记录',questions:'问题数',turns:'对话轮数',pass_rate:'已判断部分达标率',judged:'已判断记录',execution_failed:'执行失败',judge_failed:'评分异常',stability:'全对率',stability_questions:'参与稳定性统计的问题',repetitions:'计划重复次数',business_calls:'生成报告新增业务调用',score:'完整批次得分',partial_score:'已评分部分得分',retries_excluded:'排除的手动重跑'}
export const reportNumber=(n:unknown,digits=1)=>typeof n==='number'&&Number.isFinite(n)?n.toFixed(digits).replace(/\.0$/,''):'—'
export const reportProfile=(s:string)=>({ 'answers-single':'回答评审 · 单轮', 'answers-multi':'回答评审 · 多轮', 'native-single':'原生评测 · 单轮', 'native-multi':'原生评测 · 多轮' }[s]||s)
const md=(s:any)=>String(s??'未记录').replace(/[\\`*_{}\[\]<>|#]/g,'\\$&').replace(/\r?\n/g,' ')
function aiRows(rows:Row[]=[],recordLabel:(id:string)=>string=id=>id){return rows.map(r=>'- '+md(r.text)+(r.metric_refs.length?'（指标：'+r.metric_refs.map((k:string)=>reportLabels[k]||k).join('、')+'）':'')+r.evidence.map((e:Row)=>`\n  - 依据 ${md(recordLabel(e.record_id))} / ${md(e.ref)}：“${md(e.quote)}”`).join('')).join('\n')}
export function reportMarkdown(snap:Row,job?:Row,comparison?:Row){
  const m=snap.metrics,ai=job?.status==='completed'?job.result.report:null,units=snap.units as Row[],risks=units.filter(u=>u.critical.length||u.low_turns.length||u.quality==='fail')
  const recordLabel=(id:string)=>{const i=units.findIndex(u=>u.id===id);return i<0?"未匹配记录":"记录 "+(i+1)}
  const findings=decisionFindings(snap),decision=decisionSummary(snap)
  const clinical=snap.provenance==='published_snapshot'||units.some(u=>u.source?.agent==='clinical'||u.source?.agent_id==='agent_clinical')
  const lines=[`# ${md(snap.name)} · 测试报告`,'','## 一、这次结果说明什么','',`**${decision.title}**。${decision.description}`,`本报告仅适用于本次测试集、执行版本与评分标准。${clinical?'Clinical 工程评测不代表医生临床验证。':''}`,
    `已完成独立评审 ${m.assessed ?? units.filter(u=>u.assessment_status==='completed').length} / ${m.planned} 条；完成评审不代表所有维度都有足够依据计分。`,
    `完整批次得分：${reportNumber(m.score)} / 100。完整评分覆盖：${m.scored} / ${m.planned}。${m.profiles.length>1?'单轮与多轮使用不同评分维度，分别展示分组得分，不合并为一个总分。':m.score==null?'评分或依据尚不完整，暂不计算总分。':''}`,
    `关键风险：规则发现 ${m.critical.rule}，AI 提示待复核 ${m.critical.ai_pending}，人工确认 ${m.critical.human}；关键安全待判断 ${m.critical_unjudged??0} 项。`,ai?aiRows(ai.summary,recordLabel):'基础报告已就绪。AI 解读尚未生成。',job?.result?.error?'AI 解读停止原因：'+md(job.result.error):'',
    '', '## 二、测试条件','',`问题数 ${m.questions}；对话轮数 ${m.turns}；计划记录 ${m.planned}；计划重复 ${m.repetitions}；排除手动重跑 ${m.retries_excluded}。`,
    `评分口径：各适用维度等权，先平均同题独立运行，再平均问题。单轮上下文不适用；缺少参考和跨段上下文属于未知。不同评分标准分别展示。`,
    `来源：${snap.provenance==='project_saved_records'?'当前项目中保存的执行与评审记录':snap.provenance==='local_saved_records'?'本地已保存记录':snap.provenance==='published_snapshot'?'公开历史快照':'浏览器保存的用户材料，来源未独立核验'}。`,
    '', '## 三、评分与运行指标','',
    ...m.profiles.flatMap((p:Row)=>[`### ${reportProfile(p.profile)}`,`完整得分 ${reportNumber(p.score)} / 100；完整评分部分 ${reportNumber(p.partial_score)} / 100，覆盖 ${p.scored}/${p.planned}。`,
      '| 维度 | 平均档位 / 5 | 已评分 / 计划记录 |','| --- | --- | --- |',...Object.entries(p.dimensions).map(([k,v])=>{const d=v as Row;return `| ${reportLabels[k]||k} | ${reportNumber(d.score)} | ${d.scored}/${d.planned} |`})]),
    `已判断部分达标率：${m.pass_rate==null?'—':reportNumber(m.pass_rate*100)+'%'}，判断覆盖 ${m.judged}/${m.planned}。全对率：${m.stability==null?'不适用或无独立重复证据':reportNumber(m.stability*100)+'%'}。`,
    `执行失败 ${m.execution_failed}；评分异常 ${m.judge_failed}；尚无完整评分 ${m.planned-m.scored}。失败不作为零分混入质量均分。生成报告新增业务调用：0。`,
    '原执行 Token、耗时与费用未统一核验，不推算金额。报告生成自身的用量见附录。',
    '', '## 四、先处理哪些问题','',findings.length?[
      '| 优先级 | 观察到的问题 | 对用户的可能影响 | 下一步与验证方法 | 对应记录 |',
      '| --- | --- | --- | --- | --- |',
      ...findings.map((f:Row)=>`| ${f.priority===0?'优先复核关键风险':'计划复核'} | ${md(f.title)}：${md(f.reason)} | ${md(f.impact)} | ${md(f.action)} | ${md(recordLabel(f.record_id))}${f.turn?' · 第 '+f.turn+' 轮':''} |`),
    ].join('\n'):'当前已取得的判断中没有问题条目；未评分部分不能据此认定通过。',
    risks.length?'以上为依据已有判决整理的待审核事项，用户影响是待确认的解释。':'',ai?aiRows(ai.issues,recordLabel):'',
    '', '## 五、原因与证据','', '原回答、分数和失败是已记录现象；原因仍需用执行轨迹与受控重跑查证。AI 解读均待复核。',ai?aiRows(ai.strengths,recordLabel):'未生成 AI 解读，未推断根因。',
    '', '## 六、改进与回归计划','',ai?aiRows(ai.recommendations,recordLabel):'从有证据的问题记录入手，核对参考答案及逐轮期望；补充缺失评分，固定版本后复跑相同问题。',
    '推荐回归对象仅来自上述问题记录；新增测试用例属于建议，未计入本次成绩。',
    '', '## 七、局限与人工复核','', ...[...new Set(units.flatMap(u=>(u.assessment_limits||[]).map((d:Row)=>(reportLabels[d.dimension]||d.dimension)+'：'+d.reason)))].map(reason=>'- '+md(reason)), '平均分可能掩盖早期轮次错误，低分与关键风险须单独复核。规则、AI 评判和人工确认分别展示；这些分数只描述已测样本，不自动构成上线结论。',
    ai?`AI 读取 ${job!.result.ai_coverage.selected}/${job!.result.ai_coverage.total} 条记录的有限原文片段；完整问题清单保留在本报告。`: job?.result?.usage?.length?'报告模型已调用，但输出未通过校验，保留基础报告和失败证据。':'尚未调用报告模型。', ai?aiRows(ai.limitations,recordLabel):'',
    '', '## 八、附录与追溯','',`快照：${snap.snapshot_id}；模板：${snap.version}；报告：${job?.report_id||'基础报告'}；报告模型：${job?.model||'未调用'}。`,
    job?`生成状态：${job.status}；创建时间：${job.created_at}。免费余额未经接口核验，成功响应不能证明免计费。`:'',
    '| 记录与原始标识 | 完整质量分 / 100 | 评分版本 | 执行 / 评分 | 文件或用例 SHA256 |','| --- | --- | --- | --- | --- |',
    ...units.map(u=>`| ${recordLabel(u.id)} · ${md(u.id)} | ${Object.values(u.dimensions).every(v=>typeof v==='number')?reportNumber((Object.values(u.dimensions) as number[]).reduce((a,b)=>a+b,0)/Object.keys(u.dimensions).length*20):'未完整评分'} | ${md(u.assessment_id||'无')} | ${md(u.execution)} / ${md(u.assessment_status)} | ${md(u.source?.sha256||'未记录')} |`),
    '', '### 版本与评分标准',...units.map(u=>`- ${md(u.id)}：${md(JSON.stringify({profile:u.profile,rubric:u.rubric,judge_model:u.judge_model||'未记录',diagnosis_id:u.diagnosis?.assessment_id,source:u.source,scoring_contract:snap.scoring_contract}))}`),
    '', '### 报告生成用量',...(job?.result?.usage||[]).map((u:Row)=>`- 请求 ${md(u.request_id||'未取得')}；状态 ${md(u.status)}；耗时 ${u.latency_ms??'未知'} ms；Token ${md(JSON.stringify(u.usage||null))}`),
  ];if(comparison)lines.push('', '### 附加：基线对照（程序计算，未交给 AI）', comparison.note, `当前 ${comparison.current_questions} 题，基线 ${comparison.baseline_questions} 题，可比较交集 ${comparison.compared_questions} 题。`, `交集当前 ${reportNumber(comparison.current_score)}/100；交集基线 ${reportNumber(comparison.baseline_score)}/100；变化 ${reportNumber(comparison.delta)} 分。`, `当前快照 ${comparison.current_snapshot}；基线快照 ${comparison.baseline_snapshot}。`);return lines.filter(v=>v!==undefined).join('\n\n').replace(/\|\n\n\|/g,'|\n|')
}
export function reportHtml(markdown:string){
  const body=renderToStaticMarkup(createElement(ReactMarkdown,{remarkPlugins:[remarkGfm],skipHtml:true,components:{a:({children})=>createElement('span',null,children),img:()=>null},children:markdown}))
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Agent EVO 测试报告</title><style>body{max-width:1080px;margin:40px auto;padding:0 28px;color:#172238;font:15px/1.8 system-ui;overflow-wrap:anywhere}pre{white-space:pre-wrap}h1,h2,h3{line-height:1.4}h2{border-bottom:1px solid #ddd;padding:24px 0 12px;color:#075cbb}table{border-collapse:collapse;width:100%;font-size:13px;margin:20px 0}th,td{border:1px solid #dbe4ef;padding:10px;text-align:left;vertical-align:top}th{background:#f1f5fb}blockquote{margin:12px 0;padding:8px 18px;border-left:3px solid #83ace6;background:#f7f9fd}code{white-space:pre-wrap}li{margin:8px 0}@media print{body{margin:0;padding:0;font-size:11px}h2,h3{break-after:avoid}tr{break-inside:avoid}thead{display:table-header-group}}</style></head><body>'+body+'</body></html>'
}
export function downloadReport(snap:Row,job:Row|undefined,html=false,comparison?:Row){const markdown=reportMarkdown(snap,job,comparison),text=html?reportHtml(markdown):markdown;const url=URL.createObjectURL(new Blob([text],{type:html?'text/html;charset=utf-8':'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='AgentEVO-'+snap.snapshot_id.slice(0,12)+(html?'.html':'.md');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
