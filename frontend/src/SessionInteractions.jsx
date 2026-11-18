import { useState } from 'react';
import { useWorkspace } from './App';
import './session-interactions.css';

const decisions = { accept: '허용', acceptForSession: '이 세션에서 허용', decline: '거절', cancel: '취소' };
export function SessionInteraction({ session, request }) {
  const { perform } = useWorkspace();
  const [answers, setAnswers] = useState({});
  const [custom, setCustom] = useState({});
  const [fields, setFields] = useState({});
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const pending = request.status === 'pending' && ['running', 'waiting_input'].includes(session.status);
  async function respond(decision) {
    if (sending || !pending) return;
    setSending(true); setError('');
    try {
      const body = { decision };
      if (decision === 'accept' && request.kind === 'question') {
        body.answers = Object.fromEntries((request.questions || []).map(question => [question.id,
          [...(answers[question.id] || []), ...(custom[question.id]?.trim() ? [custom[question.id].trim()] : [])]]));
        for (const question of request.questions || []) if (!body.answers[question.id].length) throw new Error('모든 질문에 답해주세요.');
      }
      if (decision === 'accept' && request.schema) body.content = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== '').map(([key, value]) => {
        const type = request.schema.properties?.[key]?.type;
        return [key, type === 'number' || type === 'integer' ? Number(value) : type === 'boolean' ? value === 'true'
          : type === 'object' || type === 'array' ? JSON.parse(value) : value];
      }));
      await perform(`/sessions/${session.id}/interactions/${request.id}/respond`, 'POST', body, '응답을 전달했습니다.');
    } catch (issue) { setError(issue.message); }
    finally { setSending(false); }
  }
  return <section className={`session-interaction ${pending ? 'pending' : ''}`} aria-label={request.title}>
    <header><strong>{request.title}</strong><span>{pending ? '사용자 응답 대기' : request.status === 'answered' ? '응답 완료' : '요청 만료'}</span></header>
    {request.message && <p>{request.message}</p>}
    {request.cwd && <p>작업 경로: <code>{request.cwd}</code></p>}
    {request.command && <pre>{request.command}</pre>}
    {request.changes && <details open><summary>수정할 파일</summary><pre>{JSON.stringify(request.changes, null, 2)}</pre></details>}
    {request.details && <details open><summary>실행 내용</summary><pre>{JSON.stringify(request.details, null, 2)}</pre></details>}
    {request.permissions && (!Array.isArray(request.permissions) || request.permissions.length > 0) && <details open><summary>요청 권한 · 세션 허용 범위</summary><pre>{JSON.stringify(request.permissions, null, 2)}</pre></details>}
    {(request.questions || []).map(question => <fieldset key={question.id} disabled={!pending || sending}>
      <legend>{question.question}</legend>
      {(question.options || []).map(option => <label key={option.label} className="interaction-option">
        <input type={question.multiSelect ? 'checkbox' : 'radio'} name={`${request.id}-${question.id}`} checked={(answers[question.id] || []).includes(option.label)}
          onChange={event => {
            setAnswers(values => ({ ...values, [question.id]: question.multiSelect ? event.target.checked ? [...(values[question.id] || []), option.label] : (values[question.id] || []).filter(v => v !== option.label) : [option.label] }));
            if (!question.multiSelect) setCustom(values => ({ ...values, [question.id]: '' }));
          }} />
        <span>{option.label}{option.description && <small>{option.description}</small>}</span>
      </label>)}
      <label>직접 입력<input type={question.isSecret ? 'password' : 'text'} autoComplete="off" maxLength={16000} value={custom[question.id] || ''}
        onChange={event => { setCustom(values => ({ ...values, [question.id]: event.target.value })); if (!question.multiSelect) setAnswers(values => ({ ...values, [question.id]: [] })); }} /></label>
    </fieldset>)}
    {request.url && /^https?:\/\//i.test(request.url) && <a href={request.url} target="_blank" rel="noreferrer">요청 페이지 열기</a>}
    {request.schema && <fieldset disabled={!pending || sending}><legend>입력 항목</legend>{Object.entries(request.schema.properties || {}).map(([key, field]) => {
      const value = fields[key] ?? '';
      const change = event => setFields(current => ({ ...current, [key]: event.target.value }));
      return <label key={key}>{field.title || key}{request.schema.required?.includes(key) ? ' *' : ''}
        {field.enum || field.type === 'boolean' ? <select value={value} onChange={change}><option value="">선택하세요</option>{(field.enum || ['true', 'false']).map(option => <option key={String(option)} value={String(option)}>{field.type === 'boolean' ? option === 'true' ? '예' : '아니요' : String(option)}</option>)}</select>
          : ['object', 'array'].includes(field.type) ? <textarea rows={3} value={value} onChange={change} placeholder={field.type === 'array' ? '["항목"]' : '{"항목": "값"}'} />
            : <input type={field.writeOnly || field.format === 'password' ? 'password' : ['integer', 'number'].includes(field.type) ? 'number' : 'text'} value={value} autoComplete="off" onChange={change} />}
        {field.description && <small>{field.description}</small>}
      </label>;
    })}</fieldset>}
    {request.response && <p>응답: {request.kind === 'question' ? Object.values(request.response.answers || {}).flat().join(' / ') : decisions[request.response.decision]}</p>}
    {request.reason && <p>{request.reason}</p>}
    {pending && <div className="interaction-actions">{(request.decisions || ['accept', 'decline', 'cancel']).map(decision => <button key={decision} type="button" disabled={sending} onClick={() => respond(decision)}>
      {decision === 'accept' && request.kind === 'question' ? '답변 보내기' : decisions[decision]}
    </button>)}</div>}
    {error && <p role="alert" className="form-error">{error}</p>}
  </section>;
}

export function SessionInteractions({ session }) {
  return <div className="session-interactions">{(session.interactions || []).map(request => <SessionInteraction key={request.id} session={session} request={request} />)}</div>;
}
