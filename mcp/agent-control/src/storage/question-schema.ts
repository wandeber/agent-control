import type Database from "better-sqlite3";

export function initializeQuestionSchema(db: Database.Database): void {
  db.exec(`create table if not exists user_questions (
    question_id text primary key,
    run_id text not null references runs(run_id) on delete cascade,
    agent_id text not null references agents(agent_id) on delete cascade,
    generation integer not null, request_key text not null, record_json text not null,
    state text not null check(state in ('pending','answered','cancelled')),
    answers_json text, created_at text not null, answered_at text,
    unique(agent_id,generation,request_key)
  );
  create index if not exists user_questions_pending on user_questions(state,run_id,created_at);`);
}
