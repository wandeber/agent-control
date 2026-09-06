import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { ControllerError } from "../core/errors.js";

interface CursorState {
  processed_sequence: number;
  delivered_sequence: number;
  signing_key: string;
}

export function initializeObserverCursorSchema(db: Database.Database): void {
  db.exec(`
    create table if not exists observer_cursors (
      observer_agent_id text primary key references run_observers(observer_agent_id) on delete cascade,
      processed_sequence integer not null,
      delivered_sequence integer not null,
      signing_key text not null
    );
    create table if not exists observer_deliveries (
      observer_agent_id text not null references run_observers(observer_agent_id) on delete cascade,
      from_sequence integer not null,
      to_sequence integer not null,
      primary key(observer_agent_id, from_sequence, to_sequence)
    );
  `);
}

/** A delivered cursor is a replay position; only an explicit ACK commits processing. */
export class ObserverCursors {
  constructor(private db: Database.Database) {}

  state(observerId: string, startSequence: number): CursorState {
    const existing = this.db.prepare("select * from observer_cursors where observer_agent_id = ?").get(observerId) as CursorState | undefined;
    if (existing) return existing;
    this.db.prepare(`insert or ignore into observer_cursors values (?, ?, ?, ?)`)
      .run(observerId, startSequence, startSequence, randomBytes(32).toString("hex"));
    return this.db.prepare("select * from observer_cursors where observer_agent_id = ?")
      .get(observerId) as CursorState;
  }

  encode(runId: string, observerId: string, sequence: number, state: CursorState): string {
    const body = JSON.stringify([2, runId, observerId, sequence]);
    return Buffer.from(JSON.stringify([body, createHmac("sha256", state.signing_key).update(body).digest("hex")])).toString("base64url");
  }

  decode(cursor: string, runId: string, observerId: string, state: CursorState, allowLegacy = false): number {
    try {
      const data = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (allowLegacy && data[0] === 1 && data[1] === runId && Number.isSafeInteger(data[2]) && data[2] >= 0) return data[2];
      const [body, signature] = data;
      if (typeof body !== "string" || typeof signature !== "string") throw new Error();
      const expected = createHmac("sha256", state.signing_key).update(body).digest();
      const supplied = Buffer.from(signature, "hex");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
      const [version, run, observer, sequence] = JSON.parse(body);
      if (version === 2 && run === runId && observer === observerId && Number.isSafeInteger(sequence) && sequence >= 0) return sequence;
    } catch { /* Malformed, forged and foreign cursor receipts share one error. */ }
    throw new ControllerError("Invalid observation cursor for this run and observer.", "tool_error");
  }

  delivered(observerId: string, from: number, to: number): void {
    this.db.transaction(() => {
      this.db.prepare("insert or ignore into observer_deliveries values (?, ?, ?)").run(observerId, from, to);
      this.db.prepare("update observer_cursors set delivered_sequence = max(delivered_sequence, ?) where observer_agent_id = ?")
        .run(to, observerId);
    }).immediate();
  }

  acknowledge(observerId: string, sequence: number, state: CursorState): boolean {
    // Retrying an ACK is safe, including an older successfully handled batch.
    if (sequence <= state.processed_sequence) return false;
    let covered = state.processed_sequence;
    const deliveries = this.db.prepare(`select from_sequence, to_sequence from observer_deliveries
      where observer_agent_id = ? and to_sequence > ? order by from_sequence, to_sequence`)
      .all(observerId, covered) as Array<{ from_sequence: number; to_sequence: number }>;
    for (const delivery of deliveries) {
      if (delivery.from_sequence > covered) break;
      covered = Math.max(covered, delivery.to_sequence);
      if (covered >= sequence) break;
    }
    // An explicit replay cursor cannot silently acknowledge a gap never delivered.
    if (sequence > state.delivered_sequence || sequence > covered) {
      throw new ControllerError("Cannot acknowledge events that have not been delivered contiguously to this observer.", "tool_error");
    }
    this.db.prepare("update observer_cursors set processed_sequence = ? where observer_agent_id = ?").run(sequence, observerId);
    this.db.prepare("delete from observer_deliveries where observer_agent_id = ? and to_sequence <= ?").run(observerId, sequence);
    return true;
  }
}
