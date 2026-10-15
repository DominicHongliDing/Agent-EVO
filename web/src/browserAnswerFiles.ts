type Row = Record<string, any>
const aliases: Record<string,string[]> = {question:['用户问题','问题','用户输入','question','input','prompt'],answer:['agent回答','agent 回答','回答','回复','answer','output','response','prediction','pred'],reference:['参考答案','期望回答','期望','reference','expected_output','gold_answer'],conversation:['会话id','会话 id','conversation_id','session_id','conversation'],turn:['轮次','turn','turn_index','round'],case_id:['用例id','用例 id','case_id','question_id'],version:['测试集版本','dataset_version','version'],trace:['执行轨迹','trace','events']}
export function checkPrivate(value: unknown) {
  if (/"[^"\\]*(?:password|token|api.?key|secret|credential|authorization)[^"\\]*"\s*:|\bsk-[\w-]{16,}|(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\d)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/i.test(JSON.stringify(value))) throw Error('发现可能的个人标识或凭证，请先脱敏')
}
function table(rows: {line:number; values:string[]}[], errors:Row[]) {
  const headers=rows.shift()?.values || []
  if(!headers.length || headers.some(h=>!h.trim()) || new Set(headers).size!==headers.length) throw Error('表头含空列名或重复列名')
  return rows.flatMap(r=>{if(r.values.length!==headers.length){errors.push({line:r.line,message:'列数与表头不一致'});return []}return [{line:r.line,value:Object.fromEntries(headers.map((h,i)=>[h,r.values[i]]))}]})
}
function csv(text:string,errors:Row[]) {
  const first=text.split(/\r?\n/)[0], separator=['\t',';',','].sort((a,b)=>first.split(b).length-first.split(a).length)[0]
  const rows:{line:number;values:string[]}[]=[];let values:string[]=[],field='',quoted=false,line=1,start=1
  for(let i=0;i<=text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++}else quoted=!quoted}else if(!quoted&&(c===separator||c==='\n'||c===undefined)){values.push(field.replace(/\r$/,''));field='';if(c!==separator){if(values.some(v=>v.trim()))rows.push({line:start,values});values=[];start=line+1}}else field+=c;if(c==='\n')line++}
  if(quoted)throw Error('CSV 引号未闭合');return table(rows,errors)
}
async function xlsx(bytes:Uint8Array, errors:Row[]) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), entries=new Map<string,{size:number;compressed:number;offset:number;method:number}>();let end=-1
  for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--)if(view.getUint32(p,true)===0x06054b50){end=p;break}
  if(end<0)throw Error('Excel 压缩文件不完整')
  let p=view.getUint32(end+16,true),total=0
  for(let n=0;n<view.getUint16(end+10,true);n++){
    if(view.getUint32(p,true)!==0x02014b50)throw Error('Excel 目录损坏')
    const size=view.getUint32(p+24,true),nameLength=view.getUint16(p+28,true),name=new TextDecoder().decode(bytes.slice(p+46,p+46+nameLength));total+=size
    if(total>40*1024*1024 || view.getUint16(p+8,true)&1)throw Error('Excel 过大或已加密，请拆分或解除加密')
    entries.set(name,{size,compressed:view.getUint32(p+20,true),offset:view.getUint32(p+42,true),method:view.getUint16(p+10,true)});p+=46+nameLength+view.getUint16(p+30,true)+view.getUint16(p+32,true)
  }
  async function xml(name:string){const e=entries.get(name);if(!e)return null;const start=e.offset+30+view.getUint16(e.offset+26,true)+view.getUint16(e.offset+28,true),raw=bytes.slice(start,start+e.compressed);let decoded:Uint8Array
    if(e.method===0)decoded=raw;else if(e.method===8){const reader=new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(),chunks:Uint8Array[]=[];let len=0;try{while(true){const r=await reader.read();if(r.done)break;len+=r.value.length;if(len>e.size||len>40*1024*1024)throw Error('Excel 解压后过大');chunks.push(r.value)}}finally{await reader.cancel()}decoded=new Uint8Array(len);let at=0;for(const c of chunks){decoded.set(c,at);at+=c.length}}else throw Error('Excel 压缩方式不支持')
    const text=new TextDecoder().decode(decoded);if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('Excel 包含不支持的 XML 声明');const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))throw Error('Excel XML 不完整');return doc
  }
  const shared=Array.from((await xml('xl/sharedStrings.xml'))?.getElementsByTagName('si')||[]).map(e=>Array.from(e.getElementsByTagName('t')).map(t=>t.textContent||'').join(''))
  const sheets=[];for(const name of entries.keys())if(/^xl\/worksheets\/sheet[^/]+\.xml$/.test(name)){const doc=await xml(name),rows=Array.from(doc?.getElementsByTagName('row')||[]);if(rows.length>1)sheets.push(rows)}
  if(sheets.length!==1)throw Error('请只保留一个含数据的工作表')
  const rows=sheets[0].map(row=>{const values:string[]=[],line=Number(row.getAttribute('r'));for(const c of Array.from(row.getElementsByTagName('c'))){let col=0;for(const letter of (c.getAttribute('r')||'A').replace(/[0-9]/g,''))col=col*26+letter.charCodeAt(0)-64;if(col>1000)throw Error('Excel 列数过多');if(c.getElementsByTagName('f').length)errors.push({line,message:'含公式，请粘贴为值后导入'});const value=c.getElementsByTagName('v')[0]?.textContent||'';values[col-1]=c.getAttribute('t')==='s'?shared[Number(value)]||'':c.getAttribute('t')==='inlineStr'?Array.from(c.getElementsByTagName('t')).map(t=>t.textContent||'').join(''):value}return {line,values}})
  const width=rows[0].values.length;for(const r of rows){r.values=Array.from({length:Math.max(width,r.values.length)},(_,i)=>r.values[i]||'')};return table(rows,errors)
}
export async function parseAnswerFile(file:File) {
  if(!file.size||file.size>5*1024*1024)throw Error('请选择非空文件，大小不超过 5 MiB')
  const bytes=new Uint8Array(await file.arrayBuffer()),ext=file.name.split('.').pop()?.toLowerCase(),errors:Row[]=[];let rows:Row[]=[]
  if(ext==='xlsx')rows=await xlsx(bytes,errors)
  else {
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{if(ext!=='csv')throw Error('请使用 UTF-8 文本');text=new TextDecoder('gb18030',{fatal:true}).decode(bytes)}text=text.replace(/^\uFEFF/,'')
    if(ext==='csv')rows=csv(text,errors)
    else if(ext==='jsonl')text.split(/\r?\n/).forEach((s,i)=>{if(s.trim())try{rows.push({line:i+1,value:JSON.parse(s)})}catch{errors.push({line:i+1,message:'本行 JSON 格式不完整'})}})
    else if(ext==='json'){let data;try{data=JSON.parse(text)}catch{throw Error('JSON 格式不完整，请检查引号、逗号和括号')}checkPrivate(data);data=Array.isArray(data)?data:data?.records||data?.items||[data];if(!Array.isArray(data))throw Error('JSON 须为问答数组');rows=data.map((value,line)=>({line:line+1,value}))}
    else if(ext==='txt'){const ms=Array.from(text.matchAll(/^(用户|User|助手|Assistant|Agent)[：:]\s*/gim));if(!ms.length||text.slice(0,ms[0].index).trim())throw Error('请以“用户：”和“助手：”分行标记');rows=[{line:1,value:{messages:ms.map((m,i)=>({role:/^(用户|user)$/i.test(m[1])?'user':'assistant',content:text.slice(m.index!+m[0].length,ms[i+1]?.index??text.length).trim()}))}}]}
    else throw Error('支持 Excel、CSV、JSON、JSONL 或角色标记对话')
  }
  if(rows.length>1000)throw Error('一次最多导入 1,000 行')
  const expanded:Row[]=[]
  for(const {line,value} of rows){if(!value||Array.isArray(value)||typeof value!=='object'){errors.push({line,message:'每条记录须为问答对象'});continue}checkPrivate(value)
    if(value.turns||value.messages){let turns=value.turns;if(value.messages){const m=value.messages;if(!Array.isArray(m)||!m.length||m.length%2||m.some((v,i)=>!v||v.role!==(i%2?'assistant':'user')||typeof v.content!=='string')){errors.push({line,message:'messages 须按 user / assistant 成对排列'});continue}turns=m.filter((_:unknown,i:number)=>i%2===0).map((v:Row,i:number)=>({question:v.content,answer:m[i*2+1].content}))}if(!Array.isArray(turns)||!turns.length||turns.some(t=>!t||typeof t!=='object'||Array.isArray(t))){errors.push({line,message:'turns 须为问答数组'});continue}const {turns:_,messages:__,...base}=value;turns.forEach((t,i)=>expanded.push({line,value:{...base,...t,conversation_id:String(value.conversation_id||`file-row-${line}`),turn:i+1}}))}else expanded.push({line,value})
  }
  if(expanded.length>1000||new TextEncoder().encode(JSON.stringify(expanded)).length>10*1024*1024)throw Error('展开后的问答超过上限，请拆分文件')
  if(!expanded.length&&!errors.length)throw Error('文件没有完整问答')
  const columns=[...new Set(expanded.flatMap(r=>Object.keys(r.value)))],mapping:Record<string,string>={},ambiguous:string[]=[]
  for(const [k,names] of Object.entries(aliases)){const found=columns.filter(c=>names.includes(c.trim().toLowerCase()));mapping[k]=found.length===1?found[0]:'';if(found.length>1)ambiguous.push(k)}
  return {filename:file.name,rows:expanded,columns,mapping,ambiguous,errors}
}
export function normalizeAnswers(raw:Row,payload:Row,dataset?:Row,cases:Row[]=[]) {
  const mapping=payload.mapping||{},errors=[...raw.errors],used=Object.values(mapping).filter(Boolean),groups=new Map<string,Row>(),matches={matched:0,unmatched:0,conflict:0}
  if(Object.keys(mapping).some(k=>!aliases[k])||used.some(c=>!raw.columns.includes(c)))throw Error('列映射无效')
  if(new Set(used).size!==used.length)errors.push({line:0,message:'同一列不能同时作为不同字段'})
  for(const row of raw.rows)try{
    const f:Row={};for(const k of Object.keys(aliases).filter(k=>k!=='trace')){const v=row.value[mapping[k]];if(v!=null&&!['string','number'].includes(typeof v))throw Error('问答与标识须为文本或数字');f[k]=v==null?'':String(v).trim()}
    if(!f.answer)throw Error('Agent 回答为空');const id=f.conversation||`line-${row.line}`,g=groups.get(id)||{conversation_id:f.conversation,turns:[],source_lines:[],case_id:f.case_id};groups.set(id,g)
    if(f.conversation&&!f.turn&&!payload.confirm_order)throw Error('有会话 ID 但缺少轮次，请确认按文件顺序排列')
    if(f.turn&&!/^[1-9]\d*$/.test(f.turn))throw Error('轮次须为从 1 开始的整数');const turn=f.turn?Number(f.turn):g.turns.length+1
    if(g.turns.some((t:Row)=>t.turn===turn))throw Error('同一会话出现重复轮次');if(g.case_id!==f.case_id)throw Error('同一会话用例 ID 不一致')
    let linked_case=null
    if(dataset){const found=cases.filter(c=>c.case_id===f.case_id||c.source_case_id===f.case_id);if(found.length>1)throw Error('用例 ID 不唯一，请用平台 case_id');const c=found[0];if(c){const qs=c.turns?.length?c.turns.map((t:Row)=>t.message):[c.message];if((f.version&&f.version!==dataset.version)||turn>qs.length||(f.question&&f.question!==qs[turn-1])){matches.conflict++;throw Error('测试集版本或问题内容冲突，不能关联')}if(!f.question&&f.version!==dataset.version)throw Error('补问题需要匹配的测试集版本');f.question=qs[turn-1];linked_case={case_id:c.case_id,dataset_id:dataset.dataset_id,version:dataset.version,expected:c.expected,gold_status:c.gold_status,turn_checks:c.turns?.[turn-1]?.checks||[]};matches.matched++}else matches.unmatched++}
    if(!f.question)throw Error('缺少用户问题，请选择问题列或关联原用例');if(['question','answer','reference'].some(k=>f[k].length>40000))throw Error('单字段超过 40,000 字符，未截断原文')
    g.turns.push({turn,question:f.question,answer:f.answer,reference:f.reference,line:row.line,trace:row.value[mapping.trace]||[],linked_case});g.source_lines.push(row.line)
  }catch(e){errors.push({line:row.line,message:(e as Error).message})}
  const records=Array.from(groups.values()).filter(g=>g.turns.length),ids=new Set<string>()
  for(const r of records){r.turns.sort((a:Row,b:Row)=>a.turn-b.turn);if(r.turns.length>40||r.turns.some((t:Row,i:number)=>t.turn!==i+1))errors.push({line:r.source_lines[0],message:'最多 40 轮且轮次须从 1 连续'});if(r.case_id&&!r.conversation_id&&ids.has(r.case_id))errors.push({line:r.source_lines[0],message:'重复用例 ID，请区分会话'});ids.add(r.case_id);r.source={type:'uploaded_answers',import_id:raw.import_id,filename:raw.filename,sha256:raw.sha256,business_calls:0,execution_verified:false}}
  if(!records.length||records.length>100)errors.push({line:0,message:'每批须包含 1–100 段完整对话'})
  return {valid:!errors.length,errors,records,matches,total:records.length,turn_count:records.reduce((n,r)=>n+r.turns.length,0)}
}
