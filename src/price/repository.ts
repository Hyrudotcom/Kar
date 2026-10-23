/**
 * Loads a PriceDataset from the price tables (read-only for `authenticated` via RLS).
 * Works against a minimal structural client so it can be used with supabase-js without importing it.
 *
 * Short-circuit: when no source is verified for consumer display (v1 today), only the sources are
 * read and the engine will return state `unavailable`; no product or observation query is made.
 *
 * Completeness: PostgREST silently cuts every response at `max_rows` (1000). Every table is read in
 * pages with a stable order and an exact count, and a short read throws PriceDataError: a truncated
 * dataset would show an older price as the latest or drop prices without saying so. Observations come
 * from the view `price_observations_latest` (only the newest eligible row per product and chain).
 */
import type {
  CatalogItem,
  CatalogProductLink,
  Chain,
  PriceDataset,
  PriceMatchOverride,
  PriceObservation,
  PriceSource,
  Product,
} from '@/src/contracts';
import { isEligibleSource } from './engine';

export interface QueryResult {
  data: unknown[] | null;
  error: { message: string } | null;
  /** Exact row count when requested with { count: 'exact' }. */
  count?: number | null;
}

/** A filter builder: ordered, ranged, awaitable (the supabase-js subset used here). */
export interface PriceQuery extends PromiseLike<QueryResult> {
  order(column: string, options?: { ascending?: boolean }): PriceQuery;
  range(from: number, to: number): PriceQuery;
}

/** The subset of supabase-js used here: client.from(table).select(columns, { count }).order().range(). */
export interface PriceReadClient {
  from(table: string): { select(columns: string, options?: { count?: 'exact' }): PriceQuery };
}

/** Page size; equal to the API's max_rows, so a full page means "maybe more". */
export const PRICE_PAGE_SIZE = 1000;

export class PriceDataError extends Error {
  constructor(
    public readonly table: string,
    message: string,
  ) {
    super(`${table}: ${message}`);
    this.name = 'PriceDataError';
  }
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN);
const str = (v: unknown): string => (typeof v === 'string' ? v : String(v ?? ''));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Reads all rows in pages ordered by `orderBy` (a unique key); fails loudly on a short read. */
async function read(client: PriceReadClient, table: string, columns: string, orderBy: readonly string[]): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let total: number | null = null;
  for (let page = 0; page < 10_000; page++) {
    let q = client.from(table).select(columns, page === 0 ? { count: 'exact' } : undefined);
    for (const col of orderBy) q = q.order(col, { ascending: true });
    const { data, error, count } = await q.range(rows.length, rows.length + PRICE_PAGE_SIZE - 1);
    if (error) throw new PriceDataError(table, error.message);
    if (page === 0) {
      if (typeof count !== 'number') throw new PriceDataError(table, 'row count missing');
      total = count;
    }
    const got = (data ?? []) as Record<string, unknown>[];
    rows.push(...got);
    if (got.length === 0 || rows.length >= total!) break;
  }
  if (total === null || rows.length < total) throw new PriceDataError(table, `incomplete read: ${rows.length} of ${total ?? '?'} rows`);
  return rows;
}

export function emptyDataset(sources: PriceSource[] = []): PriceDataset {
  return { sources, chains: [], catalog: [], products: [], links: [], observations: [], overrides: [] };
}

export interface LoadOptions {
  /** Keep only this household's "Verkeerd product" overrides (RLS already limits them to the user's households). */
  householdId?: string;
}

export async function loadPriceDataset(client: PriceReadClient, opts: LoadOptions = {}): Promise<PriceDataset> {
  const sources: PriceSource[] = (
    await read(client, 'price_sources', 'id,name,licence,licence_url,attribution,channel,verified_for_consumer_display', ['id'])
  ).map((r) => ({
    id: str(r.id),
    name: str(r.name),
    licence: str(r.licence),
    licence_url: strOrNull(r.licence_url),
    attribution: strOrNull(r.attribution),
    channel: str(r.channel) as PriceSource['channel'],
    verified_for_consumer_display: r.verified_for_consumer_display === true,
  }));

  if (!sources.some(isEligibleSource)) return emptyDataset(sources);

  const [chains, catalog, products, links, observations, overrides] = await Promise.all([
    read(client, 'chains', 'id,name', ['id']),
    read(client, 'catalog_items', 'id,display_name,aliases,reference_quantity,reference_unit', ['id']),
    read(client, 'products', 'id,ean,chain_id,name,brand,net_content,net_content_unit', ['id']),
    read(client, 'catalog_product_links', 'catalog_item_id,chain_id,product_id,confidence', ['catalog_item_id', 'chain_id', 'product_id']),
    read(
      client,
      'price_observations_latest',
      'id,product_id,chain_id,source_id,price_cents,unit_price_cents,unit_price_unit,promotion,promotion_valid_until,requires_loyalty,observed_at,ingested_at',
      ['product_id', 'chain_id'],
    ),
    read(client, 'price_match_overrides', 'household_id,catalog_item_id,chain_id,created_by,created_at', ['household_id', 'catalog_item_id', 'chain_id']),
  ]);

  return {
    sources,
    chains: chains.map((r): Chain => ({ id: str(r.id), name: str(r.name) })),
    catalog: catalog.map(
      (r): CatalogItem => ({
        id: str(r.id),
        display_name: str(r.display_name),
        aliases: Array.isArray(r.aliases) ? r.aliases.map(str) : [],
        reference_quantity: num(r.reference_quantity),
        reference_unit: str(r.reference_unit) as CatalogItem['reference_unit'],
      }),
    ),
    products: products.map(
      (r): Product => ({
        id: str(r.id),
        ean: str(r.ean),
        chain_id: strOrNull(r.chain_id),
        name: str(r.name),
        brand: strOrNull(r.brand),
        net_content: num(r.net_content),
        net_content_unit: str(r.net_content_unit) as Product['net_content_unit'],
      }),
    ),
    links: links.map(
      (r): CatalogProductLink => ({
        catalog_item_id: str(r.catalog_item_id),
        chain_id: str(r.chain_id),
        product_id: str(r.product_id),
        confidence: num(r.confidence),
      }),
    ),
    observations: observations.map(
      (r): PriceObservation => ({
        id: str(r.id),
        product_id: str(r.product_id),
        chain_id: str(r.chain_id),
        source_id: str(r.source_id),
        price_cents: num(r.price_cents),
        unit_price_cents: r.unit_price_cents === null || r.unit_price_cents === undefined ? null : num(r.unit_price_cents),
        unit_price_unit: strOrNull(r.unit_price_unit) as PriceObservation['unit_price_unit'],
        promotion: (r.promotion ?? null) as PriceObservation['promotion'],
        promotion_valid_until: strOrNull(r.promotion_valid_until),
        requires_loyalty: r.requires_loyalty !== false, // anything but an explicit false is treated as loyalty-only
        observed_at: strOrNull(r.observed_at),
        ingested_at: str(r.ingested_at),
      }),
    ),
    overrides: overrides
      .filter((r) => opts.householdId === undefined || str(r.household_id) === opts.householdId)
      .map(
      (r): PriceMatchOverride => ({
        household_id: str(r.household_id),
        catalog_item_id: str(r.catalog_item_id),
        chain_id: str(r.chain_id),
        created_by: strOrNull(r.created_by),
        created_at: str(r.created_at),
      }),
    ),
  };
}
