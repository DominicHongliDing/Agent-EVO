import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowUpRight, CheckCircle2, Info, X } from 'lucide-react'
import { loadSnapshot } from './publicSnapshot'
import type { Snapshot } from './publicSnapshot'
import { AnimatePresence, MotionDialog } from './Motion'

export function PublicNotice({ onOpen, compact = false }: { onOpen: (id: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!compact) return <PublicNoticeBody onOpen={onOpen}/>
  return <><section className="public-context-bar"><Info size={15}/><span>Clinical · 历史真实记录 · 公开只读</span><button className="text-button" onClick={() => setOpen(true)}>评测说明与示例</button></section><AnimatePresence>{open && <MotionDialog label="公开评测说明" backdrop="modal-backdrop" panel="connection-dialog" onClose={() => setOpen(false)}><header><h2>评测说明与示例</h2><button className="icon-button" aria-label="关闭评测说明" onClick={() => setOpen(false)}><X size={18}/></button></header><div className="dialog-scroll"><PublicNoticeBody onOpen={id => { setOpen(false); onOpen(id) }}/></div></MotionDialog>}</AnimatePresence></>
}
function PublicNoticeBody({ onOpen }: { onOpen: (id: string) => void }) {
  const [data, setData] = useState<Snapshot | null>(null)
  useEffect(() => { loadSnapshot().then(setData).catch(() => {}) }, [])
  return <section className="public-evidence-notice" aria-label="公开记录说明">
    <div className="public-evidence-heading"><Info size={18}/><div><strong>Clinical · 本地真实评测，公开只读浏览</strong><p>完整使用本地平台的界面与已保存证据；线上浏览不会发起新的模型调用。</p></div><a href="/" target="_top"><ArrowLeft size={14}/> 官网</a></div>
    {data && <div className="public-evidence-metrics"><span><b>{data.statistics.primary_finished}/{data.statistics.primary_cases}</b> 主批次已结束</span><span><b>{data.statistics.primary_model_calls}</b> 次历史业务模型调用</span><span><b>{data.statistics.primary_quality_failed_records}</b> 条含质量失败</span><span><b>{data.statistics.additional_records}</b> 条独立多轮实例</span></div>}
    <details className="public-method"><summary>本地怎样实现评测？查看实现流程与真实多轮例子</summary><div className="public-method-grid"><article><span>01 · 接入</span><h3>调用真实业务入口</h3><p>本地 FastAPI Runner 调用 Clinical Chat 后端，关联业务 Run ID 与平台 Trace ID。多轮调用沿用同一业务会话；已有原生交互记录可以直接导入评测。</p></article><article><span>02 · 记录</span><h3>每一步保存证据</h3><p>将意图、上下文、检索、回答核验与模型用量事件写入 SQLite。页面中的输入、答复、节点和原始输出均来自这些已保存记录。</p></article><article><span>03 · 排查</span><h3>定位偏差，受控重跑</h3><p>规则检查、独立语义评审与人工复核分开。失败保留证据、疑似原因和其他解释；在本地固定用例与版本后创建新重跑记录，历史证据继续保留。</p></article></div><div className="public-examples"><strong>真实多轮例子</strong><p>“两周”更正为“三天”后，检查下一轮是否采用新事实；回答重复澄清模板的实际失败也保留在记录中。</p><button className="outline" onClick={() => onOpen('run_c0a39b1970e24bce9dc55e0dbf83e043')}>打开两轮更正与完整答复 <ArrowUpRight size={14}/></button><button className="plain" onClick={() => onOpen('run_2d33cc2222be4f96abce4e1bb1b27cbe')}>查看三轮完整交互</button></div><div className="public-scope"><CheckCircle2 size={15}/><span>公开数据仅含 Clinical 合成场景。50 条主批次为历史 v1 工程集；多轮实例独立列出。完成运行不代表质量通过，待判断不当作通过。医生临床验证尚未开展；接入、上传、删除、置顶、重跑与复核提交在本地执行。</span></div></details>
  </section>
}
