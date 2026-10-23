/**
 * Price status per observation (design-spec 4.5 rule 2, architecture 6.2 rule 3).
 *   no observed_at / unparseable / in the future -> unknown
 *   age <= 7 x 24 h                               -> verified ("ok", no mark)
 *   7 x 24 h < age <= 14 x 24 h                   -> stale ("4 d oud", still counts)
 *   older                                         -> unknown (never estimated)
 *   link confidence < 0.9 or "Verkeerd product"   -> unknown
 */
import { PRICE_AGE_RULES, type IsoTimestamp, type PriceStatus, type PriceStatusOf } from '@/src/contracts';

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Clock skew we tolerate for observed_at slightly ahead of the device clock. Anything further in
 * the future is treated as bad data (unknown) rather than as "brand new".
 */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Parses an ISO timestamp; null when missing or invalid. */
export function parseTimestamp(ts: IsoTimestamp | null | undefined): number | null {
  if (typeof ts !== 'string' || ts.length === 0) return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

/** Age in ms (clamped at 0 within the allowed skew), or null when unknown / too far in the future. */
export function ageMs(observedAt: IsoTimestamp | null, now: number): number | null {
  const t = parseTimestamp(observedAt);
  if (t === null || !Number.isFinite(now)) return null;
  const age = now - t;
  if (age < -FUTURE_SKEW_MS) return null;
  return Math.max(0, age);
}

/** Whole days for display ("4 d oud"): floor of the age. */
export function ageDays(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

export function statusForAge(ms: number | null): PriceStatus {
  if (ms === null) return 'unknown';
  if (ms <= PRICE_AGE_RULES.verifiedMaxDays * DAY_MS) return 'verified';
  if (ms <= PRICE_AGE_RULES.staleMaxDays * DAY_MS) return 'stale';
  return 'unknown';
}

export function isConfidentLink(confidence: unknown): boolean {
  return (
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= PRICE_AGE_RULES.minMatchConfidence &&
    confidence <= 1
  );
}

export const priceStatusOf: PriceStatusOf = (observedAt, now, confidence, overridden) => {
  if (overridden) return 'unknown';
  if (!isConfidentLink(confidence)) return 'unknown';
  return statusForAge(ageMs(observedAt, now));
};
