import type { Clock } from '@/src/contracts';

/** Deterministic clock for tests: timers only fire on advance(). */
export class FakeClock implements Clock {
  private t: number;
  private nextId = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = Date.UTC(2026, 9, 23, 8, 0, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /**
   * Sets the wall clock (now()) by `ms` without touching how long pending timers still wait, like a
   * user changing the phone's time: timers are monotonic, Date.now() is not.
   */
  shiftWall(ms: number): void {
    this.t += ms;
    for (const tm of this.timers.values()) tm.at += ms;
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  /** Moves time forward, firing due timers in order. Awaits microtasks between timers. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, tm] of this.timers) {
        if (tm.at <= end && (tm.at < nextAt || (tm.at === nextAt && id < (nextId ?? Infinity)))) {
          nextAt = tm.at;
          nextId = id;
        }
      }
      if (nextId === null) break;
      const tm = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.t = Math.max(this.t, tm.at);
      tm.fn();
      await flushMicrotasks();
    }
    this.t = end;
    await flushMicrotasks();
  }
}

export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
  await new Promise<void>((r) => (typeof setImmediate === 'function' ? setImmediate(r) : setTimeout(r, 0)));
}

