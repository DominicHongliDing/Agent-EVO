import { useState } from 'react';
import './evo-evaluation.css';

type Turn = { turn_index: number; message: string; status: string; model_calls: number; answer_coverage: string; output: { result?: { assistant_message?: { content?: string }; answer?: string | { summary?: string; sections?: { title?: string; content?: string }[] } } } };
type Preview = { turns: Turn[]; requires_attachments: boolean; preview_sha256: string };
type Result = { run_id: string; url: string; deduplicated: boolean };

function answer(turn: Turn): string {
  const result = turn.output.result;
  if (result?.assistant_message?.content) return result.assistant_message.content;
  if (typeof result?.answer === 'string') return result.answer;
  const value = result?.answer;
  return [value?.summary, ...(value?.sections || []).map(section => section.content)].filter(Boolean).join('\n\n');
}

export default function EvoEvaluationPanel({ conversationId, post }: { conversationId: string | null; post: (path: string, body: object) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [classification, setClassification] = useState('deidentified');
  const [redactions, setRedactions] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [end, setEnd] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const command = () => ({ data_classification: classification, privacy_confirmed: confirmed, redact_terms: redactions.split(/\n/).map(term => term.trim()).filter(Boolean) });
  const load = async () => {
    if (!conversationId) return;
    setBusy(true); setError(''); setResult(null);
    try { const value = await post(`/evo/conversations/${encodeURIComponent(conversationId)}/preview`, command()) as Preview; setPreview(value); setEnd(value.turns.length); }
    catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!conversationId || !preview) return;
    setBusy(true); setError('');
    try { setResult(await post(`/evo/conversations/${encodeURIComponent(conversationId)}/evaluate`, { ...command(), end_turn: end, expected_sha256: preview.preview_sha256 }) as Result); }
    catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  return <>
    <button type="button" className="evo-entry" disabled={!conversationId} onClick={() => { setOpen(true); setConfirmed(false); setPreview(null); setResult(null); void load(); }}>评测此对话</button>
    {open && <div className="evo-overlay"><section className="evo-panel" role="dialog" aria-modal="true" aria-label="对话记录评测">
      <header><div><h2>对话记录评测</h2><p>复用真实问答与节点记录 · 本次不重新调用业务 Agent</p></div><button type="button" aria-label="关闭评测面板" disabled={busy} onClick={() => setOpen(false)}>关闭</button></header>
      <div className="evo-controls"><label>记录类型<select value={classification} onChange={event => { setClassification(event.target.value); setPreview(null); setConfirmed(false); }}><option value="deidentified">已脱敏的交互记录</option><option value="synthetic">合成场景的交互记录</option></select></label>
      <label>额外脱敏词（每行一个）<textarea value={redactions} placeholder="需要替换的姓名、组织名称等" onChange={event => { setRedactions(event.target.value); setPreview(null); setConfirmed(false); }}/></label>
      <button type="button" disabled={busy} onClick={() => void load()}>{busy ? '正在处理…' : '刷新脱敏预览'}</button></div>
      {error && <p className="evo-error" role="alert">{error}</p>}
      {preview && <><label className="evo-end">评测范围<select value={end} onChange={event => setEnd(Number(event.target.value))}>{preview.turns.map(turn => <option key={turn.turn_index} value={turn.turn_index}>第 1 轮至第 {turn.turn_index} 轮</option>)}</select><span>保留之前的完整上下文</span></label>
        <div className="evo-transcript">{preview.turns.slice(0, end).map(turn => <details key={turn.turn_index} open={turn.turn_index === end}><summary>第 {turn.turn_index} 轮 · {turn.status === 'completed' ? '已回答' : '证据不完整'} · 历史模型调用 {turn.model_calls} 次</summary><strong>用户输入</strong><p>{turn.message}</p><strong>Agent 回答{turn.answer_coverage === 'saved_summary' ? '（保存的摘要）' : ''}</strong><p>{answer(turn) || '未找到关联回答，评测将标记待判断'}</p></details>)}</div>
        {preview.requires_attachments && <p>原会话含附件。评测保留节点证据，重跑需要另行准备脱敏附件。</p>}
        <label className="evo-confirm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>我已核对预览，内容为合成或已脱敏资料，不含真实患者、招聘个人资料及凭证。</label>
        <footer><span>独立模型评审另计调用；结论需人工复核。</span><button type="button" disabled={busy || !confirmed} onClick={() => void submit()}>评测所选轮次</button></footer>
      </>}
      {result && <div className="evo-success"><strong>{result.deduplicated ? '此记录已提交，已复用原评测' : '已提交，后台正在评测'}</strong><p>新增业务调用：0 次</p><a href={result.url} target="_blank" rel="noopener noreferrer">打开逐轮评测结果</a></div>}
    </section></div>}
  </>;
}
