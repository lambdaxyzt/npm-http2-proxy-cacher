/**
 * Coalesces concurrent async operations that share the same key so the work
 * runs at most once at a time. Callers that arrive while an operation is
 * in flight receive the same promise; the entry is cleared once it settles.
 */
export class SingleFlight<T = void> {
  private readonly inflight = new Map<string, Promise<T>>();

  /** Returns the in-flight promise for `key`, or undefined if none is running. */
  peek(key: string): Promise<T> | undefined {
    return this.inflight.get(key);
  }

  /**
   * Starts `fn` for `key` if nothing is in flight, otherwise returns the
   * existing promise. `leader` is true only for the caller that started the work.
   */
  run(key: string, fn: () => Promise<T>): { promise: Promise<T>; leader: boolean } {
    const existing = this.inflight.get(key);
    if (existing) return { promise: existing, leader: false };

    const promise = (async () => fn())().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return { promise, leader: true };
  }
}
