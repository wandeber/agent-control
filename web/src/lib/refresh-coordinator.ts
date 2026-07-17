/**
 * Serializes periodic MCP App reads. A tool call can outlive a React selection
 * change, so each start/stop advances a generation and stale results are
 * discarded. Calls requested during an in-flight refresh are coalesced into a
 * single next run; there is never more than one MCP refresh promise active.
 */
export class SerialRefreshCoordinator<T> {
  private generation = 0;
  private inFlight = false;
  private queued = false;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private task: (() => Promise<T>) | null = null;
  private onResult: ((value: T) => void) | null = null;
  private onError: ((error: unknown) => void) | null = null;

  constructor(private readonly intervalMs = 1400) {}

  start(input: {
    task: () => Promise<T>;
    onResult: (value: T) => void;
    onError: (error: unknown) => void;
  }): void {
    this.generation += 1;
    this.active = true;
    this.task = input.task;
    this.onResult = input.onResult;
    this.onError = input.onError;
    this.clearTimer();
    this.request();
  }

  request(): void {
    if (!this.active || !this.task) {
      return;
    }
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    this.clearTimer();
    this.run();
  }

  stop(): void {
    // The promise itself cannot be cancelled safely, but advancing the
    // generation guarantees its callbacks cannot mutate the new selection.
    this.generation += 1;
    this.active = false;
    this.queued = false;
    this.task = null;
    this.onResult = null;
    this.onError = null;
    this.clearTimer();
  }

  private run(): void {
    const task = this.task;
    if (!this.active || !task || this.inFlight) {
      return;
    }

    const generation = this.generation;
    const startedAt = Date.now();
    this.inFlight = true;
    this.queued = false;

    void task()
      .then((value) => {
        if (this.active && generation === this.generation) {
          this.onResult?.(value);
        }
      })
      .catch((error: unknown) => {
        if (this.active && generation === this.generation) {
          this.onError?.(error);
        }
      })
      .finally(() => {
        this.inFlight = false;
        if (!this.active) {
          return;
        }

        // If start() replaced the task while this request was running, execute
        // the newest generation next. Otherwise keep a steady cadence measured
        // from the previous start, coalescing every trigger in the interval.
        const elapsedMs = Date.now() - startedAt;
        const delayMs = Math.max(0, this.intervalMs - elapsedMs);
        const shouldRunAgain = this.queued || generation !== this.generation;
        this.timer = setTimeout(() => {
          this.timer = null;
          if (shouldRunAgain || this.active) {
            this.request();
          }
        }, delayMs);
      });
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
