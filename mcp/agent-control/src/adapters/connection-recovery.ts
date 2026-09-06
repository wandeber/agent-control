import { ControllerError } from "../core/errors.js";

/** Bound connection attempts across short-lived clients; never replay RPC work. */
export class ConnectionRecovery {
  private readonly failures = new Map<string, { retryAt: number }>();
  constructor(private readonly cooldownMs = 30_000, private readonly now = () => Date.now()) {}

  async connect(key: string, attempt: () => Promise<void>): Promise<void> {
    const failure = this.failures.get(key);
    if (failure && failure.retryAt > this.now()) {
      throw new ControllerError("Backend disconnected; waiting before reconnecting.", "backend_unavailable", {
        retry_after_ms: failure.retryAt - this.now()
      });
    }
    try {
      await attempt();
      this.failures.delete(key);
    } catch (error) {
      // Bound retained endpoint state as well as retry frequency.
      if (this.failures.size >= 128) this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(key, { retryAt: this.now() + this.cooldownMs });
      throw error;
    }
  }
}

/** Recover a managed listener before any application request is submitted. */
export async function connectWithStartup(
  connect: () => Promise<void>, start: () => Promise<void>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<void> {
  await start();
  for (let attempt = 0; ; attempt += 1) {
    try { await connect(); return; }
    catch (error) {
      if (attempt >= 2) throw error;
      await wait(250 * (attempt + 1));
    }
  }
}
