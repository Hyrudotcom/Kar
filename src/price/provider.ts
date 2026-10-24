/**
 * Price providers (ingestion side). Today there is NO licensed Dutch price source
 * (discovery/price-provider-verdict.md): the registry is intentionally empty, so the app shows
 * "Geen geverifieerde prijzen beschikbaar". Do not add a provider here without a signed licence that
 * allows consumer display; scraping-based sources and unofficial app endpoints are never allowed.
 *
 * Providers run server side only (service role ingestion into public.price_observations). The
 * mobile app never talks to a provider directly; it reads the price tables (read-only via RLS).
 */
import type { BaseUnit, PriceChannel, PriceSource, Promotion } from '@/src/contracts';
import { isValidGtin } from './ean';
import { parseTimestamp } from './status';
import { isBaseUnit } from './units';

/** One price as delivered by a provider, before it is linked to public.products. */
export interface ProviderObservation {
  ean: string;
  chain_id: string;
  price_cents: number; // shelf price for one package, integer cents
  net_content: number | null;
  net_content_unit: BaseUnit | null;
  unit_price_cents: number | null;
  unit_price_unit: BaseUnit | null;
  promotion: Promotion | null;
  promotion_valid_until: string | null;
  requires_loyalty: boolean;
  /** Moment of observation at the source. Required for a price to ever count (null = unknown). */
  observed_at: string | null;
}

export interface ProviderRequest {
  eans: string[];
  chain_ids: string[];
}

export interface PriceProvider {
  /** Matches public.price_sources; must have verified_for_consumer_display = true to be registered. */
  readonly source: PriceSource;
  fetchObservations(request: ProviderRequest, signal?: AbortSignal): Promise<ProviderObservation[]>;
}

/** Licensed providers wired into ingestion. Empty on purpose: none exists today. */
export const PRICE_PROVIDERS: readonly PriceProvider[] = Object.freeze([]);

export type ProviderAvailability =
  | { available: true; providers: readonly PriceProvider[] }
  | { available: false; reason: 'no_licensed_source' };

const ELIGIBLE_CHANNELS: readonly PriceChannel[] = ['national', 'webshop'];

export function isRegistrableProvider(p: PriceProvider): boolean {
  return p.source.verified_for_consumer_display === true && ELIGIBLE_CHANNELS.includes(p.source.channel);
}

/** Honest availability: only providers with a consumer-display licence count. */
export function providerAvailability(providers: readonly PriceProvider[] = PRICE_PROVIDERS): ProviderAvailability {
  const ok = providers.filter(isRegistrableProvider);
  return ok.length > 0 ? { available: true, providers: ok } : { available: false, reason: 'no_licensed_source' };
}

export type ObservationRejection =
  | 'invalid_ean'
  | 'invalid_price'
  | 'invalid_content'
  | 'invalid_unit_price'
  | 'invalid_observed_at'
  | 'invalid_promotion';

/**
 * Validates a provider row before ingestion. A row without observed_at is accepted (it is stored and
 * always classified as unknown) but rows with impossible values are rejected outright, so that no
 * zero or garbage price can ever reach the engine.
 */
export function validateProviderObservation(o: ProviderObservation): ObservationRejection | null {
  if (!isValidGtin(o.ean)) return 'invalid_ean';
  if (!Number.isSafeInteger(o.price_cents) || o.price_cents <= 0) return 'invalid_price';
  if ((o.net_content === null) !== (o.net_content_unit === null)) return 'invalid_content';
  if (o.net_content !== null && (!(o.net_content > 0) || !Number.isFinite(o.net_content) || !isBaseUnit(o.net_content_unit)))
    return 'invalid_content';
  if ((o.unit_price_cents === null) !== (o.unit_price_unit === null)) return 'invalid_unit_price';
  if (o.unit_price_cents !== null && (!Number.isSafeInteger(o.unit_price_cents) || o.unit_price_cents <= 0 || !isBaseUnit(o.unit_price_unit)))
    return 'invalid_unit_price';
  if (o.observed_at !== null && parseTimestamp(o.observed_at) === null) return 'invalid_observed_at';
  if (o.promotion !== null) {
    const p = o.promotion;
    const okMulti = p.type === 'multi_buy' && Number.isSafeInteger(p.min_quantity) && p.min_quantity >= 2 && Number.isSafeInteger(p.total_cents) && p.total_cents > 0;
    const okXY = p.type === 'x_plus_y' && Number.isSafeInteger(p.buy) && p.buy > 0 && Number.isSafeInteger(p.free) && p.free > 0;
    if (!okMulti && !okXY) return 'invalid_promotion';
  }
  return null;
}
