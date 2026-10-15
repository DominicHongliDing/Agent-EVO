import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
export default function ReadableReport({text}:{text:string}){
 const marker=text.search(/^## 八[、．.]/m),body=marker<0?text:text.slice(0,marker),appendix=marker<0?'':text.slice(marker)
 const render=(value:string)=><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{a:({children})=><span>{children}</span>}}>{value}</ReactMarkdown>
 return <article className="report-document">{render(body)}{appendix&&<details className="report-options"><summary>技术附录：版本、原始标识与用量</summary>{render(appendix)}</details>}</article>
}
