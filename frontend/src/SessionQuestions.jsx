import { useState } from 'react';
import { useWorkspace } from './App';
export function SessionQuestions({ sessionId }) {
  const { data } = useWorkspace();
  const items = (data.inputRequests || []).filter(item => item.status === 'pending' && (!sessionId || item.sessionId === sessionId));
  return <>{items.map(item => <SessionQuestion key={item.id} item={item} />)}</>;
}
export function SessionQuestion({ item }) {
  const { perform, busy, data } = useWorkspace();
  const [answers, setAnswers] = useState({});
  const [error, setError] = useState('');
  async function submit(event) {
    event.preventDefault();
    try { await perform(`/input-requests/${item.id}/answer`, 'POST', { answers: Object.fromEntries(Object.entries(answers).map(([key, text]) => [key, [text]])) }, '답변을 전달했습니다.'); }
    catch (error) { setError(error.message); }
  }
  return <form className="panel session-question" onSubmit={submit}><h3>{data.members.find(member => member.id === item.memberId)?.name || 'AI'}의 질문</h3>
    {item.questions.map(question => <fieldset key={question.id}><legend>{question.question}</legend>
      {question.options?.map(option => <button key={option.label} type="button" className="button secondary" onClick={() => setAnswers(current => ({ ...current, [question.id]: option.label }))}>{option.label}</button>)}
      <textarea aria-label={question.question} required rows={2} value={answers[question.id] || ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} maxLength={16000} />
    </fieldset>)}<button disabled={busy} className="button primary">답변하고 계속</button>{error && <p role="alert">{error}</p>}
  </form>;
}
