"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, MessageCircleQuestion } from "lucide-react";
import { answerUserQuestion } from "@/lib/api";
import { useConsoleSelection } from "./console-selection";
import type { UserQuestionAnswers, UserQuestionRequest } from "@/lib/types";

export function QuestionBadge({ count, avatar = false }: { count: number; avatar?: boolean }) {
  if (!count) return null;
  const label = `${count} pending ${count === 1 ? "question" : "questions"}`;
  return <span role="img" aria-label={label} title={label} className={`question-badge${avatar ? " question-avatar" : ""}`}>
    <MessageCircleQuestion aria-hidden="true" className={avatar ? "size-4" : "size-3.5"} />
    {!avatar && count > 1 ? <span>{count}</span> : null}
  </span>;
}

export function QuestionInbox({ requests, expanded, onExpandedChange, onSelectAgent }: { requests: UserQuestionRequest[]; expanded: boolean; onExpandedChange: (expanded: boolean) => void; onSelectAgent: (request: UserQuestionRequest) => void }) {
  const pending = requests.filter(request => request.state === "pending");
  const [cursor, setCursor] = useState({ id: pending[0]?.question_id, index: 0 });
  const selectedIndex = pending.findIndex(request => request.question_id === cursor.id);
  const page = selectedIndex >= 0 ? selectedIndex : Math.max(0, Math.min(cursor.index, pending.length - 1));
  const selectedId = pending[page]?.question_id;
  useEffect(() => {
    setCursor(previous => previous.id === selectedId && previous.index === page ? previous : { id: selectedId, index: page });
  }, [selectedId, page]);
  const previousIds = useRef(new Set<string>());
  const pendingIds = pending.map(request => request.question_id).join(":");
  useEffect(() => {
    const next = new Set(pendingIds ? pendingIds.split(":") : []);
    if ([...next].some(id => !previousIds.current.has(id))) onExpandedChange(true);
    previousIds.current = next;
  }, [pendingIds, onExpandedChange]);
  if (!pending.length) return null;
  return <aside className="question-inbox" hidden={!expanded} aria-label="Questions from your agents">
    <header className="question-inbox-heading">
      <MessageCircleQuestion className="size-4" /><h2>Questions for you</h2>
      <nav className="question-inbox-pagination" aria-label="Question navigation">
        <button type="button" aria-label="Previous question" title="Previous question" disabled={page === 0} onClick={() => setCursor({ id: pending[page - 1].question_id, index: page - 1 })}><ChevronLeft className="size-3.5" /></button>
        <span aria-label={`Question ${page + 1} of ${pending.length}`}>{page + 1} / {pending.length}</span>
        <button type="button" aria-label="Next question" title="Next question" disabled={page === pending.length - 1} onClick={() => setCursor({ id: pending[page + 1].question_id, index: page + 1 })}><ChevronRight className="size-3.5" /></button>
      </nav>
      <button type="button" aria-label="Collapse questions" aria-expanded={expanded} onClick={() => onExpandedChange(false)}><ChevronDown className="size-4" /></button>
    </header>
    <p className="sr-only" role="status">{pending.map(request => `${request.agent_title} has a question`).join(". ")}</p>
    <div className="question-inbox-body" hidden={!expanded}>
      {/* Keep each form mounted so paging and live updates preserve unfinished answers. */}
      {pending.map((request, index) => <div key={request.question_id} hidden={index !== page}>
        <QuestionCard request={request} onSelectAgent={onSelectAgent} />
      </div>)}
    </div>
  </aside>;
}

export function QuestionCards({ requests, onSelectAgent }: { requests: UserQuestionRequest[]; onSelectAgent?: (request: UserQuestionRequest) => void }) {
  return <div className="question-cards">{requests.map(request => <QuestionCard key={request.question_id} request={request} onSelectAgent={onSelectAgent} />)}</div>;
}

function QuestionCard({ request, onSelectAgent }: { request: UserQuestionRequest; onSelectAgent?: (request: UserQuestionRequest) => void }) {
  const { refreshCurrentScreen } = useConsoleSelection();
  const [answers, setAnswers] = useState<UserQuestionAnswers>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<UserQuestionRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = submitted ?? request;
  const pending = current.state === "pending";
  const displayed = pending ? answers : current.answers ?? {};
  const complete = request.questions.every(item => (answers[item.id]?.option_ids.length ?? 0) > 0 || Boolean(answers[item.id]?.text.trim()));
  const update = (id: string, patch: Partial<UserQuestionAnswers[string]>) => setAnswers(previous => ({ ...previous, [id]: { ...(previous[id] ?? { option_ids: [], text: "" }), ...patch } }));

  return <form className="question-card" data-question-id={request.question_id} onSubmit={async event => {
    event.preventDefault();
    if (!pending || !complete || submitting) return;
    setSubmitting(true); setError(null);
    try { setSubmitted(await answerUserQuestion(request, answers)); refreshCurrentScreen(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSubmitting(false); }
  }}>
    <div className="question-card-owner">
      <QuestionBadge count={pending ? 1 : 0} />
      {onSelectAgent ? <button type="button" onClick={() => onSelectAgent(request)} title="Show this agent">{request.agent_title}</button> : <strong>{request.agent_title}</strong>}
      <span title={request.run_title}>{request.run_title}</span>
    </div>
    <h3>{request.title}</h3>
    {request.questions.map(item => <fieldset key={item.id} disabled={!pending || submitting}>
      <legend>{item.prompt}</legend>
      {item.options?.length ? <div className="question-options">{item.options.map(option => <label key={option.id}>
        <input type={item.multiple ? "checkbox" : "radio"} name={`${request.question_id}:${item.id}`} value={option.id}
          checked={displayed[item.id]?.option_ids.includes(option.id) ?? false}
          onChange={event => update(item.id, { option_ids: item.multiple
            ? event.target.checked ? [...(answers[item.id]?.option_ids ?? []), option.id] : (answers[item.id]?.option_ids ?? []).filter(id => id !== option.id)
            : [option.id] })} />
        <span><span>{option.label}</span>{option.description ? <small>{option.description}</small> : null}</span>
      </label>)}</div> : null}
      <textarea rows={2} maxLength={8000} aria-label={`Written answer: ${item.prompt}`} placeholder={item.options ? "Or write your own answer…" : "Your answer…"}
        value={displayed[item.id]?.text ?? ""} onChange={event => update(item.id, { text: event.target.value })} />
    </fieldset>)}
    {error ? <p role="alert" className="question-error">{error}</p> : null}
    <footer>{pending ? <button className="question-submit" type="submit" disabled={!complete || submitting}>{submitting ? "Sending…" : "Send answer"}</button>
      : <span className="question-answered"><Check className="size-3.5" />{current.state === "answered" ? "Answer saved" : "Question cancelled"}</span>}</footer>
  </form>;
}
