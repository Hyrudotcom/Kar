/**
 * Exact quantity arithmetic for the price engine.
 *
 * All amounts are converted to BigInt "micro base units" (base unit x 1e6) so that pack counts
 * never suffer from floating point drift (0.3 kg / 300 g must be exactly 1 pack, not 2).
 * List quantities and net contents have at most 3 decimals (numeric(12,3)), so the scale is exact.
 */
import type { BaseUnit, Unit } from '@/src/contracts';

/** 1 base unit (g, ml or stuk) = 1e6 micro units. */
export const MICRO = 1_000_000n;

const BASE_UNITS: readonly BaseUnit[] = ['g', 'ml', 'stuk'];

export function isBaseUnit(u: unknown): u is BaseUnit {
  return typeof u === 'string' && (BASE_UNITS as readonly string[]).includes(u);
}

/** Positive, finite number -> value x 1000 as BigInt (3 decimals, rounded). null if not usable. */
export function toMilli(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const milli = Math.round(value * 1000);
  if (milli <= 0 || !Number.isSafeInteger(milli)) return null;
  return BigInt(milli);
}

/** Net content of one package in micro base units, or null if invalid. */
export function contentMicro(netContent: unknown): bigint | null {
  const m = toMilli(netContent);
  return m === null ? null : m * 1000n;
}

/**
 * Required amount for a list item, expressed in the catalog item's reference unit (design-spec 4.5 rule 1,
 * architecture 6.2 rule 2):
 *  - `stuk` on the list means "n x the reference size" ("2 melk" = 2 x 1 l)
 *  - g/kg and ml/l are converted to g resp. ml; they must match the reference dimension
 *  - any dimension mismatch (e.g. "1 kg bananen" vs a catalog item counted per stuk) -> null (unknown)
 */
export function requiredMicro(
  quantity: number,
  unit: Unit,
  referenceQuantity: number,
  referenceUnit: BaseUnit,
): bigint | null {
  const q = toMilli(quantity);
  if (q === null || !isBaseUnit(referenceUnit)) return null;
  switch (unit) {
    case 'stuk': {
      const ref = toMilli(referenceQuantity);
      return ref === null ? null : q * ref; // (q*1000) * (ref*1000) = q*ref*1e6
    }
    case 'g':
      return referenceUnit === 'g' ? q * 1000n : null;
    case 'kg':
      return referenceUnit === 'g' ? q * 1_000_000n : null;
    case 'ml':
      return referenceUnit === 'ml' ? q * 1000n : null;
    case 'l':
      return referenceUnit === 'ml' ? q * 1_000_000n : null;
    default:
      return null;
  }
}

/** ceil(a / b) for positive BigInts. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/** Micro units -> number with at most 3 decimals (for display fields such as overage). */
export function microToNumber(micro: bigint): number {
  // round half up to 3 decimals: micro / 1000 (milli), then / 1000
  const milli = (micro + 500n) / 1000n;
  return Number(milli) / 1000;
}

export type UnitPricePer = 'kg' | 'l' | 'stuk';

export interface UnitPrice {
  /** Price in cents per kg, per l or per stuk, rounded half up to whole cents. */
  cents: number;
  per: UnitPricePer;
}

/**
 * Comparable unit price of one package: per kg (g products), per l (ml products) or per stuk.
 * For detergents, catalog items count wasbeurten as `stuk` (net_content = number of wasbeurten),
 * so `per: 'stuk'` reads as "per wasbeurt" there. Returns null on invalid input. Display only:
 * the engine itself always compares the cost of the required quantity, never unit prices.
 */
export function unitPrice(priceCents: number, netContent: number, netUnit: BaseUnit): UnitPrice | null {
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) return null;
  const content = toMilli(netContent);
  if (content === null || !isBaseUnit(netUnit)) return null;
  // cents per base unit = price / net_content; per kg/l multiply by 1000.
  const factor = netUnit === 'stuk' ? 1n : 1000n;
  const num = BigInt(priceCents) * factor * 1000n; // net_content is x1000
  const cents = (num * 2n + content) / (content * 2n); // round half up
  const per: UnitPricePer = netUnit === 'g' ? 'kg' : netUnit === 'ml' ? 'l' : 'stuk';
  return { cents: Number(cents), per };
}
