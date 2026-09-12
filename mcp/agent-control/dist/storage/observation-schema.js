import { initializeObserverCursorSchema } from "./observer-cursors.js";
/** Keep observation order independent of timestamps and SQLite's mutable rowids. */
export function initializeObservationSchema(db) {
    db.transaction(() => {
        const exists = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'event_order'").get();
        db.exec(`
      create table if not exists event_order (
        sequence integer primary key autoincrement,
        event_id text not null unique references events(event_id) on delete cascade
      );
      create trigger if not exists event_observation_order after insert on events begin
        insert into event_order(event_id) values (new.event_id);
      end;
      create table if not exists run_observers (
        observer_agent_id text primary key references agents(agent_id) on delete cascade,
        run_id text not null references runs(run_id) on delete cascade,
        thread_id text not null,
        events_json text not null,
        delivery text not null check(delivery in ('wait', 'notify')),
        start_sequence integer not null,
        created_at text not null,
        unique(run_id, thread_id)
      );
      create table if not exists observer_owners (
        observer_agent_id text not null references run_observers(observer_agent_id) on delete cascade,
        orchestrator_agent_id text not null references agents(agent_id) on delete cascade,
        primary key(observer_agent_id, orchestrator_agent_id)
      );
      create table if not exists run_requesters (
        run_id text primary key references runs(run_id) on delete cascade,
        thread_id text not null
      );
      create table if not exists run_operator_bindings (
        run_id text primary key references runs(run_id) on delete cascade,
        thread_id text not null
      );
      create table if not exists observer_subscriptions (
        subscription_id text primary key references subscriptions(subscription_id) on delete cascade,
        observer_agent_id text not null references run_observers(observer_agent_id) on delete cascade
      );
      create table if not exists observer_notifications (
        observer_agent_id text not null references run_observers(observer_agent_id) on delete cascade,
        event_id text not null references events(event_id) on delete cascade,
        status text not null check(status in ('invoking', 'injected', 'failed')),
        primary key(observer_agent_id, event_id)
      );
      create table if not exists agent_activity (
        agent_id text primary key references agents(agent_id) on delete cascade,
        activity_json text not null
      );
      create table if not exists run_conversation_usage (
        run_id text not null references runs(run_id) on delete cascade,
        agent_id text not null references agents(agent_id) on delete cascade,
        thread_id text not null,
        started_at text not null,
        ended_at text,
        snapshot_json text not null,
        evidence_json text not null default '[]',
        primary key(run_id, agent_id)
      );
    `);
        if (!db.prepare("pragma table_info(run_conversation_usage)").all().some(column => column.name === "evidence_json")) {
            db.exec("alter table run_conversation_usage add column evidence_json text not null default '[]'");
        }
        if (!exists) {
            db.exec("insert or ignore into event_order(event_id) select event_id from events order by created_at, rowid");
        }
        initializeObserverCursorSchema(db);
    }).immediate();
}
