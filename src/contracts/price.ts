/**
 * Price data model + comparison engine contract. Owner: architect; implemented in src/price/**
 * and supabase/migrations/*_prices.sql (price builder). See docs/architecture.md section 6.
 *
 * Hard rules (design-spec 4.5, price-provider-verdict.md):
 * - only licensed, verified sources; today there are NONE -> UI shows "Geen geverifieerde prijzen beschikbaar"
 * - match by catalog item -> per-chain EAN link (never by name/weight alone), package size and required quantity
 * - an unknown price is never 0; incomplete baskets show no total and are never ranked
 * - rank only complete single-store baskets; no 2/3-store routes in v1
 * - all money in integer euro cents
 */
import type { IsoTimestamp, Unit, Uuid } from './domain';

/** Status of one price for one item at one store. Dutch UI: ok (no mark) / "verouderd" / "Geen prijs". */
export type PriceStatus = 'verified' | 'stale' | 'unknown';

export const PRICE_AGE_RULES = {
  /** 0..7 days old (inclusive of 7*24h) = verified */
  verifiedMaxDays: 7,
  /** >7..14 days = stale (counts towards complete, shown as "4 d oud") */
  staleMaxDays: 14,
  /** below this link confidence = unknown */
  minMatchConfidence: 0.9,
  /** overage above this fraction is shown in the item line ("600 g, 100 g meer") */
  overageNoticeFraction: 0.25,
  /** a comparison is offered only when at least this many chains have a verified licensed source */
  minVerifiedChains: 2,
} as const;

/** Base units used for net content and conversion. kg->g, l->ml. */
export type BaseUnit = 'g' | 'ml' | 'stuk';

export type PriceChannel = 'national' | 'webshop';

/** public.price_sources */
export interface PriceSource {
  id: string; // e.g. 'open_prices'
  name: string;
  licence: string; // e.g. 'ODbL-1.0'
  licence_url: string | null;
  attribution: string | null;
  channel: PriceChannel;
  /** Only true after a signed licence that allows consumer display. False for everything today. */
  verified_for_consumer_display: boolean;
}

/** public.chains */
export interface Chain {
  id: string; // 'ah', 'jumbo', 'plus', 'lidl', 'aldi', 'dirk', 'picnic', 'coop'
  name: string; // 'Albert Heijn'
}

/** public.catalog_items: one generic item with a fixed variant and reference size (rule 1). */
export interface CatalogItem {
  id: string; // slug, e.g. 'melk-halfvol'
  display_name: string;
  /** normalized names (gb_normalize_name) that map to this item */
  aliases: string[];
  reference_quantity: number; // e.g. 1000
  reference_unit: BaseUnit; // e.g. 'ml'
}

/** public.products: a concrete sellable product. */
export interface Product {
  id: Uuid;
  ean: string; // GTIN-8/12/13/14, digits only
  chain_id: string | null; // null for brand products sold everywhere; private label = chain id
  name: string;
  brand: string | null;
  net_content: number; // in net_content_unit
  net_content_unit: BaseUnit;
}

/** public.catalog_product_links: pre-approved EAN link per chain (rule 1, P2). */
export interface CatalogProductLink {
  catalog_item_id: string;
  chain_id: string;
  product_id: Uuid;
  confidence: number; // 0..1
}

export type Promotion =
  | { type: 'multi_buy'; min_quantity: number; total_cents: number } // "2 voor €3"
  | { type: 'x_plus_y'; buy: number; free: number }; // "1+1"

/** public.price_observations */
export interface PriceObservation {
  id: Uuid;
  product_id: Uuid;
  chain_id: string;
  source_id: string;
  price_cents: number; // shelf price for ONE package
  unit_price_cents: number | null; // per kg / l / stuk as reported by the source
  unit_price_unit: BaseUnit | null;
  promotion: Promotion | null;
  promotion_valid_until: IsoTimestamp | null;
  requires_loyalty: boolean; // loyalty/app-only prices never count (rule 5)
  /** Moment of observation at the source. null = unknown (rule 2). */
  observed_at: IsoTimestamp | null;
  ingested_at: IsoTimestamp;
}

/** public.price_match_overrides: "Verkeerd product" (household-wide, per item per chain, reversible). */
export interface PriceMatchOverride {
  household_id: Uuid;
  catalog_item_id: string;
  chain_id: string;
  created_by: Uuid | null;
  created_at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Engine I/O (pure, synchronous, deterministic; `now` is injected)
// ---------------------------------------------------------------------------

export interface BasketRequestItem {
  list_item_id: Uuid;
  name: string;
  normalized_name: string;
  quantity: number;
  unit: Unit;
  /** "Niet vergelijken" */
  excluded: boolean;
}

export interface PriceDataset {
  sources: PriceSource[];
  chains: Chain[];
  catalog: CatalogItem[];
  products: Product[];
  links: CatalogProductLink[];
  observations: PriceObservation[];
  overrides: PriceMatchOverride[];
}

export interface CompareInput {
  items: BasketRequestItem[]; // open + checked items until "Wissen" (rule 8)
  data: PriceDataset;
  now: number; // epoch ms
  /** listFingerprint(items): stable hash of compared items; survives restarts (rule 9 cache). */
  list_fingerprint: string;
}

export interface BasketLine {
  list_item_id: Uuid;
  item_name: string;
  status: PriceStatus;
  catalog_item_id: string | null;
  product_name: string | null;
  ean: string | null;
  package_count: number | null; // n in "2×"
  package_content: number | null; // per package, base unit
  package_unit: BaseUnit | null;
  line_total_cents: number | null; // null when status = unknown. NEVER 0 for unknown.
  overage: { amount: number; unit: BaseUnit } | null; // only when > 25%
  age_days: number | null;
  promotion_applied: boolean;
}

export interface StoreBasket {
  chain_id: string;
  chain_name: string;
  complete: boolean;
  /** Only for complete baskets. */
  total_cents: number | null;
  /** Difference to the cheapest complete basket ("+€2,68"); null for the cheapest and incomplete ones. */
  delta_cents: number | null;
  priced_count: number; // "10 van 12 prijzen"
  compared_count: number;
  stale_count: number;
  label: 'cheapest' | 'only_complete' | null;
  lines: BasketLine[];
}

export type ComparisonState =
  | 'unavailable' // < 2 chains with verified licensed source: v1 state, "Geen geverifieerde prijzen beschikbaar"
  | 'empty' // no items to compare: "Nog niets te vergelijken"
  | 'ranked' // >= 1 complete basket
  | 'no_complete'; // "Geen winkel heeft al je prijzen"

export interface ComparisonResult {
  state: ComparisonState;
  compared_count: number;
  excluded_count: number;
  oldest_price_age_days: number | null;
  /** complete baskets ascending by total (ties: chain name), then incomplete by priced_count desc */
  stores: StoreBasket[];
  list_fingerprint: string;
  computed_at: number;
  source_ids: string[];
}

/** Implemented in src/price/engine.ts */
export type CompareBaskets = (input: CompareInput) => ComparisonResult;

/** Implemented in src/price/status.ts */
export type PriceStatusOf = (observedAt: IsoTimestamp | null, now: number, confidence: number, overridden: boolean) => PriceStatus;

/** Implemented in src/price/fingerprint.ts: hash of sorted (list_item_id, normalized_name, quantity, unit, excluded). */
export type ListFingerprint = (items: BasketRequestItem[]) => string;
