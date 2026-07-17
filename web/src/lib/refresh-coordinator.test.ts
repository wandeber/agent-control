import { afterEach, describe, expect, it, vi } from "vitest";
import { SerialRefreshCoordinator } from "./refresh-coordinator";

afterEach(() => {
  vi.useRealTimers();
});

describe("SerialRefreshCoordinator", () => {
  it("coalesces triggers while a refresh is running and never overlaps tasks", async () => {
    vi.useFakeTimers();
    const resolvers: Array<(value: number) => void> = [];
    let active = 0;
    let maximumActive = 0;
    const task = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          resolvers.push((value) => {
            active -= 1;
            resolve(value);
          });
        })
    );
    const results: number[] = [];
    const coordinator = new SerialRefreshCoordinator<number>(1400);

    coordinator.start({ task, onResult: (value) => results.push(value), onError: () => undefined });
    coordinator.request();
    coordinator.request();
    expect(task).toHaveBeenCalledTimes(1);

    resolvers.shift()?.(1);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1400);
    expect(task).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    expect(results).toEqual([1]);

    coordinator.stop();
    resolvers.shift()?.(2);
    await Promise.resolve();
  });

  it("drops stale results when a new generation replaces the task", async () => {
    vi.useFakeTimers();
    let resolveOld: ((value: string) => void) | null = null;
    const oldTask = () =>
      new Promise<string>((resolve) => {
        resolveOld = resolve;
      });
    const results: string[] = [];
    const coordinator = new SerialRefreshCoordinator<string>(1400);

    coordinator.start({ task: oldTask, onResult: (value) => results.push(value), onError: () => undefined });
    coordinator.start({ task: async () => "new", onResult: (value) => results.push(value), onError: () => undefined });

    const finishOld = resolveOld as ((value: string) => void) | null;
    finishOld?.("old");
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1400);
    await Promise.resolve();
    expect(results).toEqual(["new"]);

    coordinator.stop();
  });
});
