import './decisions.css'
export default function MaterialTemplates({kind='questions'}:{kind?:'questions'|'answers'}){
  return <section aria-label="可下载的材料样本"><div className="template-links"><a href={`templates/${kind}.xlsx`} download>下载 Excel 样本</a><a href={`templates/${kind}.csv`} download>下载 CSV 样本</a><a href="templates/execution-example.jsonl" download>开发者：输入包示例</a></div><p className="template-help">{kind==='questions'?'问题模板包含用户问题与希望做到的要求，无需事先取得回答。':'回答模板包含问题、实际回答和可选参考资料。'}附 3 条合成示例，其中一条为两轮对话。请替换为自己的任务并确认预期。</p></section>
}
