/** A failed worker read must not discard a healthy team snapshot or cached chat. */
export class AgentDetailReader<M, L> {
  private failures = new Map<string, { until: number; error: Error }>();
  constructor(private readonly now = Date.now) {}
  async read(id: string, messages: () => Promise<M>, log: () => Promise<L>): Promise<{
    messages: M | null; log: L | null; agentError?: Error;
  }> {
    const failure = this.failures.get(id);
    if (failure && failure.until > this.now()) return { messages: null, log: null, agentError: failure.error };
    let messageResult: M | null = null;
    let logResult: L | null = null;
    let agentError: Error | undefined;
    const recordError = (error: unknown) => { agentError ??= error instanceof Error ? error : new Error(String(error)); };
    try { messageResult = await messages(); } catch (error) { recordError(error); }
    try { logResult = await log(); } catch (error) { recordError(error); }
    if (agentError) {
      if (this.failures.size >= 128) this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(id, { until: this.now() + 30_000, error: agentError });
    } else {
      this.failures.delete(id);
    }
    return { messages: messageResult, log: logResult, ...(agentError ? { agentError } : {}) };
  }
}
