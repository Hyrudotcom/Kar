import type { Clock, Connectivity } from '@/src/contracts';

/** FIFO async mutex. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;

/**
 * Exponential backoff with jitter: attempt 1 -> ~1 s, 2 -> ~2 s, 3 -> ~4 s ... capped at 60 s.
 * Jitter keeps the delay in [0.75, 1.0] x the nominal value, so retries of many devices spread out
 * but never fire earlier than 75 % of the schedule.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const nominal = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 16));
  return Math.round(nominal * (0.75 + 0.25 * random()));
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Connectivity whose state the caller sets (tests, web preview). */
export class ManualConnectivity implements Connectivity {
  private listeners = new Set<(online: boolean) => void>();
  constructor(private online = true) {}

  isOnline(): boolean {
    return this.online;
  }

  set(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    for (const l of [...this.listeners]) l(online);
  }

  subscribe(listener: (online: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
