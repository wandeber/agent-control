import { realpathSync } from "node:fs";
import Database from "../storage/database.js";

/** One session supervisor per state database, even with one MCP server per chat. */
export class SessionSupervision {
  private lock: Database.Database | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly databasePath: string, private readonly reconcile: () => void) {}

  start(): void { if (!this.timer && !this.stopped) this.tick(); }

  get isOwner(): boolean { return this.lock !== null; }

  private tick(): void {
    if (this.stopped) return;
    try {
      if (!this.lock) {
        // Use a separate database: never hold the controller's write lock while
        // idle. SQLite releases this OS lock on exit/crash without PID guessing
        // or lease expiry that could create two owners during a long GC pause.
        const path = this.databasePath === ":memory:" ? ":memory:"
          : `${realpathSync(this.databasePath)}.session-supervision.sqlite`;
        const candidate = new Database(path, { timeout: 0 });
        try {
          candidate.exec("BEGIN IMMEDIATE");
          this.lock = candidate;
        } catch (error) {
          candidate.close();
          throw error;
        }
      }
      this.reconcile();
    } catch {
      // Contenders do no session I/O. Retry boundedly after contention or a
      // temporary filesystem failure; persisted rollout events remain replayable.
    } finally {
      this.timer = setTimeout(() => this.tick(), 5_000);
      this.timer.unref();
    }
  }

  /** Cancel discovery first; release ownership only after local work drains. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  close(): void {
    this.stop();
    this.lock?.close();
    this.lock = null;
  }
}
