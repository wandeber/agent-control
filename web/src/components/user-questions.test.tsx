import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { QuestionInbox } from "./user-questions";
import { ConsoleSelectionProvider } from "./console-selection";
import { Timeline } from "./timeline";
import { combineRunSnapshots } from "../lib/run-snapshots";
import type { DashboardSnapshot, UserQuestionRequest } from "../lib/types";
const date = (at: number) => new Date(at).toISOString();
const question = (agent: string): UserQuestionRequest => ({ question_id: agent, agent_id: agent, run_id: agent, agent_title: agent, run_title: `Room ${agent}`, state: "pending", answers: null, answered_at: null, created_at: date(0), request_key: agent, title: "Choose a direction", questions: [{ id: "style", prompt: "Which direction fits your portfolio?", options: [{ id: "light", label: "Light" }, { id: "dark", label: "Dark" }] }] });
it("pages pending rooms one at a time with no implied answer or selection", () => {
  const html = renderToStaticMarkup(<ConsoleSelectionProvider><QuestionInbox requests={[question("A"), question("B"), { ...question("C"), state: "answered" }]} expanded onExpandedChange={() => {}} onSelectAgent={() => {}} /></ConsoleSelectionProvider>);
  expect(html).toContain("Room A"); expect(html).toContain("Room B"); expect(html).not.toContain("Room C");
  expect(html).not.toContain("checked=");
  expect(html).toContain('aria-label="Question 1 of 2"');
  expect(html).toContain('aria-label="Question navigation"');
  expect(html).toContain('<div><form class="question-card" data-question-id="A"');
  expect(html).toContain('<div hidden=""><form class="question-card" data-question-id="B"');
  expect(html.match(/Send answer/g)).toHaveLength(2);
  expect(html.match(/<textarea/g)).toHaveLength(2);
});
function snapshot(agent: string, from: number, until: number, spans: Array<[number, number | null]>): DashboardSnapshot {
  return { generated_at: date(until), agents: [{ agent_id: agent, title: agent, status: "running" }], computed_agents: [], flow_instances: [], flow_steps: [], flows: [], latest_events: [], user_questions: [],
    agent_timeline: { started_at: date(from), ended_at: date(until), rows: [{ agent_id: agent, source: "native", coverage: "complete", segments: spans.map(([start, end], i) => ({ id: `${agent}:${i}`, started_at: date(start), ended_at: end === null ? null : date(end) })) }] } } as unknown as DashboardSnapshot;
}
it("uses common positions for concurrent agents and leaves a resumed gap", () => {
  const combined = combineRunSnapshots([snapshot("A", 0, 100, [[10, 30], [50, 70]]), snapshot("B", 0, 100, [[20, 40]])])!;
  const html = renderToStaticMarkup(<Timeline snapshot={combined} selectedStepInstanceId={null} />);
  expect(html).toContain('left:10%;width:20%'); expect(html).toContain('left:20%;width:20%'); expect(html).toContain('left:50%;width:20%');
  expect(html.match(/activity-timeline-bar/g)).toHaveLength(3);
});
it("combines timelines without extending an older open interval to another run's clock", () => {
  const combined = combineRunSnapshots([snapshot("A", 0, 100, [[20, null]]), snapshot("B", 50, 200, [[70, null]])])!;
  expect(combined.agent_timeline).toMatchObject({ started_at: date(0), ended_at: date(200), rows: [
    { agent_id: "A", segments: [{ ended_at: date(100) }] }, { agent_id: "B", segments: [{ ended_at: date(200) }] }
  ] });
});
