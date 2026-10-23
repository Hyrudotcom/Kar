/**
 * Packaging and promotions (design-spec 4.5 rules 4 and 5, architecture 6.2 rule 4).
 *
 * n = ceil(required / net_content) packages of ONE product. Cost = n x shelf price, or the
 * promotion price when n reaches the promotion and the promotion is provably still valid.
 * All money is integer cents (BigInt internally, checked back to a safe Number).
 */
import type { Promotion } from '@/src/contracts';
import { parseTimestamp } from './status';
import { ceilDiv } from './units';

export interface PackCost {
  packages: bigint;
  cost_cents: bigint;
  promotion_applied: boolean;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/** A promotion is only used with a known end that lies after `now` (a vanished end date = expired). */
export function isPromotionUsable(promotion: Promotion | null, validUntil: string | null, now: number): boolean {
  if (!promotion || typeof promotion !== 'object') return false;
  const until = parseTimestamp(validUntil);
  if (until === null || until <= now) return false;
  if (promotion.type === 'multi_buy') {
    return isPositiveInt(promotion.min_quantity) && promotion.min_quantity >= 2 && isPositiveInt(promotion.total_cents);
  }
  if (promotion.type === 'x_plus_y') {
    return isPositiveInt(promotion.buy) && isPositiveInt(promotion.free);
  }
  return false;
}

/** Cost of `packages` packages at `priceCents` each, applying the promotion only when it is reached. */
export function costForPackages(
  packages: bigint,
  priceCents: number,
  promotion: Promotion | null,
  promotionUsable: boolean,
): PackCost {
  const price = BigInt(priceCents);
  const regular = packages * price;
  if (!promotionUsable || !promotion) return { packages, cost_cents: regular, promotion_applied: false };

  let promo: bigint;
  if (promotion.type === 'multi_buy') {
    const min = BigInt(promotion.min_quantity);
    if (packages < min) return { packages, cost_cents: regular, promotion_applied: false };
    promo = (packages / min) * BigInt(promotion.total_cents) + (packages % min) * price;
  } else {
    const group = BigInt(promotion.buy + promotion.free);
    if (packages < group) return { packages, cost_cents: regular, promotion_applied: false };
    promo = (packages - (packages / group) * BigInt(promotion.free)) * price;
  }
  // A "promotion" that is more expensive than the shelf price is never applied.
  return promo < regular
    ? { packages, cost_cents: promo, promotion_applied: true }
    : { packages, cost_cents: regular, promotion_applied: false };
}

/** Packages needed for `requiredMicro` with packages of `contentMicro` each. */
export function packagesNeeded(requiredMicro: bigint, contentMicro: bigint): bigint {
  return ceilDiv(requiredMicro, contentMicro);
}
