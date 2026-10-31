import { useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type { AgentChatRequest, AgentChatAnswer } from '../shared/chat';
import './codex-chat.css';

export default function NativeRequest({ request, disabled, answer, agentName = 'Codex', onTerminal }: { agentName?: string; request: AgentChatRequest; disabled: boolean; answer: (id: string, answer: AgentChatAnswer) => Promise<void>; onTerminal?: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(payload: AgentChatAnswer) {
    if (busy || disabled) return;
    setBusy(true); setError('');
    try { await answer(request.id, payload); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '提交失败'); }
    finally { setBusy(false); }
  }
  const questions = request.questions ?? [];
  const complete = questions.every(question => !!(values[question.id] === '__other__' ? other[question.id]?.trim() : values[question.id]?.trim()));
  return <section className="codex-request" aria-label={request.kind === 'question' ? `${agentName} 提问` : `${agentName} 审批`}>
    <div className="codex-request-heading"><CircleAlert size={16} /><h3>{request.title}</h3></div>
    {request.description && <p>{request.description}</p>}
    {request.details && <details open><summary>操作详情</summary><pre>{request.details}</pre></details>}
    {request.kind === 'question' ? <form onSubmit={(event) => {
      event.preventDefault(); if (!complete) return;
      void submit({ answers: Object.fromEntries(questions.map(question => [question.id, [values[question.id] === '__other__' ? other[question.id].trim() : values[question.id].trim()]])) });
    }}>
      {questions.map(question => <fieldset key={question.id} disabled={disabled || busy}><legend>{question.header && <span>{question.header} · </span>}{question.question}</legend>
        {question.options?.length ? <><div className="codex-question-options">{question.options.map(option => <label key={option.label}><input type="radio" name={`${request.id}-${question.id}`} value={option.label} checked={values[question.id] === option.label} onChange={() => setValues(current => ({ ...current, [question.id]: option.label }))} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}{question.isOther && <label><input type="radio" name={`${request.id}-${question.id}`} checked={values[question.id] === '__other__'} onChange={() => setValues(current => ({ ...current, [question.id]: '__other__' }))} /><span>其他答案</span></label>}</div>
          {values[question.id] === '__other__' && <input aria-label={`${question.question}：其他答案`} type={question.isSecret ? 'password' : 'text'} value={other[question.id] ?? ''} onChange={event => setOther(current => ({ ...current, [question.id]: event.target.value }))} maxLength={8000} autoComplete="off" />}</>
          : <input aria-label={question.question} type={question.isSecret ? 'password' : 'text'} value={values[question.id] ?? ''} onChange={event => setValues(current => ({ ...current, [question.id]: event.target.value }))} maxLength={8000} autoComplete="off" />}
      </fieldset>)}<button type="submit" className="button primary small-button" disabled={disabled || busy || !complete}>{busy ? '提交中…' : '提交回答'}</button>
    </form> : <div className="codex-approval-actions">{request.options?.map(option => <button type="button" key={option.id} className="button secondary small-button" disabled={disabled || busy} onClick={() => void submit({ decision: option.id })}>{option.label}</button>)}{request.kind === 'unsupported' && <><p>当前界面还不能处理这个请求，请在原生界面中核对。</p>{onTerminal && <button type="button" className="button secondary small-button" onClick={onTerminal}>打开原生界面</button>}</>}</div>}
    {error && <p className="codex-request-error" role="alert">{error}</p>}
  </section>;
}

