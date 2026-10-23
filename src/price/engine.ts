/**
 * Single-store basket comparison (design-spec 4.5, architecture 6.2). Pure, synchronous and
 * deterministic: the same input always yields the same output; `now` is injected.
 *
 * Non-negotiables:
 *  - list item -> catalog item by exact normalized alias; catalog item -> product ONLY via a
 *    pre-approved per-chain EAN link (never by name, brand or weight)
 *  - an unknown price is never 0; a basket with any unknown line has no total and is never ranked
 *  - only complete single-store baskets are ranked; no multi-store routes
 *  - integer cents only
 */
import {
  PRICE_AGE_RULES,
  type BasketLine,
  type BasketRequestItem,
  type CatalogItem,
  type Chain,
  type CompareBaskets,
  type ComparisonResult,
  type PriceObservation,
  type PriceSource,
  type PriceStatus,
  type Product,
  type StoreBasket,
} from '@/src/contracts';
import { normalizeName } from '@/src/shared/normalize';
import { costForPackages, isPromotionUsable, packagesNeeded } from './packaging';
import { ageDays, ageMs, isConfidentLink, parseTimestamp, statusForAge } from './status';
import { contentMicro, isBaseUnit, microToNumber, requiredMicro, unitPrice } from './units';

const ELIGIBLE_CHANNELS: readonly string[] = ['national', 'webshop'];

/** Deterministic, locale independent string order (code points). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isUsablePriceCents(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/** Source may feed consumer-facing prices: signed licence + national/webshop channel. */
export function isEligibleSource(s: PriceSource | undefined): s is PriceSource {
  return !!s && s.verified_for_consumer_display === true && ELIGIBLE_CHANNELS.includes(s.channel);
}

interface ObsPick {
  obs: PriceObservation;
  observedAt: number;
  age: number;
  status: PriceStatus; // verified | stale | unknown (too old)
}

/** Latest observation wins: observed_at desc, then ingested_at desc, then id asc. */
function isNewer(a: ObsPick, b: ObsPick): boolean {
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt;
  const ai = parseTimestamp(a.obs.ingested_at) ?? -Infinity;
  const bi = parseTimestamp(b.obs.ingested_at) ?? -Infinity;
  if (ai !== bi) return ai > bi;
  return cmpStr(a.obs.id, b.obs.id) < 0;
}

interface Candidate {
  product: Product;
  pick: ObsPick;
  packages: bigint;
  cost: bigint;
  overage: bigint;
  promotion_applied: boolean;
}

function betterCandidate(a: Candidate, b: Candidate): boolean {
  if (a.cost !== b.cost) return a.cost < b.cost; // lowest total price
  if (a.overage !== b.overage) return a.overage < b.overage; // then smallest overage
  if (a.pick.status !== b.pick.status) return a.pick.status === 'verified'; // then fresher status
  if (a.pick.observedAt !== b.pick.observedAt) return a.pick.observedAt > b.pick.observedAt;
  const e = cmpStr(a.product.ean, b.product.ean);
  if (e !== 0) return e < 0;
  return cmpStr(a.product.id, b.product.id) < 0;
}

function unknownLine(item: BasketRequestItem, catalogId: string | null): BasketLine {
  return {
    list_item_id: item.list_item_id,
    item_name: item.name,
    status: 'unknown',
    catalog_item_id: catalogId,
    product_name: null,
    ean: null,
    package_count: null,
    package_content: null,
    package_unit: null,
    line_total_cents: null,
    overage: null,
    age_days: null,
    observed_at: null,
    promotion_applied: false,
    promotion_valid_until: null,
    unit_price: null,
  };
}

export const compareBaskets: CompareBaskets = (input) => {
  const { data, now } = input;

  // ---- items: dedupe by id (first wins), split excluded ("Niet vergelijken") --------------------
  const seen = new Set<string>();
  const items: BasketRequestItem[] = [];
  for (const it of input.items) {
    if (seen.has(it.list_item_id)) continue;
    seen.add(it.list_item_id);
    items.push(it);
  }
  const compared = items.filter((i) => !i.excluded);
  const excludedCount = items.length - compared.length;

  const base: Omit<ComparisonResult, 'state'> = {
    compared_count: compared.length,
    excluded_count: excludedCount,
    oldest_price_age_days: null,
    stores: [],
    list_fingerprint: input.list_fingerprint,
    computed_at: now,
    source_ids: [],
  };

  // ---- reference data ----------------------------------------------------------------------------
  const sources = new Map<string, PriceSource>();
  for (const s of data.sources) if (isEligibleSource(s)) sources.set(s.id, s);

  const chains = new Map<string, Chain>();
  for (const c of data.chains) if (!chains.has(c.id)) chains.set(c.id, c);

  const products = new Map<string, Product>();
  for (const p of data.products) if (!products.has(p.id)) products.set(p.id, p);

  // ---- latest eligible observation per (product, chain) -------------------------------------------
  const latest = new Map<string, ObsPick>(); // key product|chain
  for (const o of data.observations) {
    if (!sources.has(o.source_id)) continue; // unlicensed or wrong channel
    if (!chains.has(o.chain_id)) continue;
    if (o.requires_loyalty) continue; // klantenkaart/app prices never count
    if (!isUsablePriceCents(o.price_cents)) continue; // 0 or garbage is never a price
    const product = products.get(o.product_id);
    if (!product) continue;
    if (product.chain_id !== null && product.chain_id !== o.chain_id) continue; // private label of another chain
    const age = ageMs(o.observed_at, now);
    if (age === null) continue; // no / invalid / future observed_at: unknown
    const pick: ObsPick = { obs: o, observedAt: parseTimestamp(o.observed_at)!, age, status: statusForAge(age) };
    const key = `${o.product_id}|${o.chain_id}`;
    const prev = latest.get(key);
    if (!prev || isNewer(pick, prev)) latest.set(key, pick);
  }
  // ---- catalog alias index (an alias claimed by two catalog items is ambiguous -> no match) -------
  const aliasIndex = new Map<string, CatalogItem | null>();
  for (const c of data.catalog) {
    if (!isBaseUnit(c.reference_unit)) continue;
    const names = new Set((c.aliases ?? []).map((a) => normalizeName(a)).filter((a) => a.length > 0));
    for (const a of names) {
      const prev = aliasIndex.get(a);
      aliasIndex.set(a, prev === undefined || prev?.id === c.id ? c : null);
    }
  }

  // ---- explicit EAN links per (catalog item, chain) --------------------------------------------------
  const links = new Map<string, Product[]>(); // key catalog|chain
  const catalogById = new Map(data.catalog.map((c) => [c.id, c] as const));
  for (const l of data.links) {
    if (!isConfidentLink(l.confidence)) continue;
    const cat = catalogById.get(l.catalog_item_id);
    const product = products.get(l.product_id);
    if (!cat || !product || !chains.has(l.chain_id)) continue;
    if (product.net_content_unit !== cat.reference_unit) continue; // never compare per kg with per tros
    if (product.chain_id !== null && product.chain_id !== l.chain_id) continue; // AH huismerk is not a Jumbo product
    const key = `${l.catalog_item_id}|${l.chain_id}`;
    const list = links.get(key) ?? [];
    if (!list.some((p) => p.id === product.id)) list.push(product);
    links.set(key, list);
  }

  // ---- coverage: a chain counts only with a VERIFIED (<= 7 d) price for a product reachable through
  // a confident catalog link (design-spec 4.5: at least 2 verified chains). Stale-only prices or
  // prices of unlinked products never switch the comparison on.
  const coveredChains = new Set<string>();
  for (const [key, list] of links) {
    const chainId = key.slice(key.lastIndexOf('|') + 1);
    if (list.some((p) => latest.get(`${p.id}|${chainId}`)?.status === 'verified')) coveredChains.add(chainId);
  }

  // ---- state: unavailable (v1 today) / empty --------------------------------------------------------
  if (coveredChains.size < PRICE_AGE_RULES.minVerifiedChains) return { ...base, state: 'unavailable' };
  if (compared.length === 0) return { ...base, state: 'empty' };

  const overridden = new Set(data.overrides.map((o) => `${o.catalog_item_id}|${o.chain_id}`));

  // ---- per chain baskets ------------------------------------------------------------------------------
  const usedSources = new Set<string>();
  let oldestAge: number | null = null;
  const baskets: StoreBasket[] = [];

  const chainIds = [...coveredChains].sort(cmpStr);
  for (const chainId of chainIds) {
    const chain = chains.get(chainId)!;
    const lines: BasketLine[] = [];
    let total = 0n;
    let priced = 0;
    let stale = 0;

    for (const item of compared) {
      const cat = aliasIndex.get(normalizeName(item.normalized_name || item.name)) ?? null;
      if (!cat) {
        lines.push(unknownLine(item, null));
        continue;
      }
      if (overridden.has(`${cat.id}|${chainId}`)) {
        lines.push(unknownLine(item, cat.id));
        continue;
      }
      const required = requiredMicro(item.quantity, item.unit, cat.reference_quantity, cat.reference_unit);
      if (required === null) {
        lines.push(unknownLine(item, cat.id));
        continue;
      }

      let best: Candidate | null = null;
      for (const product of links.get(`${cat.id}|${chainId}`) ?? []) {
        const pick = latest.get(`${product.id}|${chainId}`);
        if (!pick || pick.status === 'unknown') continue;
        const content = contentMicro(product.net_content);
        if (content === null) continue;
        const packages = packagesNeeded(required, content);
        const usable = isPromotionUsable(pick.obs.promotion, pick.obs.promotion_valid_until, now);
        const cost = costForPackages(packages, pick.obs.price_cents, pick.obs.promotion, usable);
        if (cost.cost_cents > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(Number(packages))) continue;
        const cand: Candidate = {
          product,
          pick,
          packages,
          cost: cost.cost_cents,
          overage: packages * content - required,
          promotion_applied: cost.promotion_applied,
        };
        if (!best || betterCandidate(cand, best)) best = cand;
      }

      if (!best) {
        lines.push(unknownLine(item, cat.id));
        continue;
      }

      const showOverage =
        best.overage * 1000n > required * BigInt(Math.round(PRICE_AGE_RULES.overageNoticeFraction * 1000));
      const days = ageDays(best.pick.age);
      lines.push({
        list_item_id: item.list_item_id,
        item_name: item.name,
        status: best.pick.status,
        catalog_item_id: cat.id,
        product_name: best.product.name,
        ean: best.product.ean,
        package_count: Number(best.packages),
        package_content: microToNumber(contentMicro(best.product.net_content)!),
        package_unit: best.product.net_content_unit,
        line_total_cents: Number(best.cost),
        overage: showOverage ? { amount: microToNumber(best.overage), unit: best.product.net_content_unit } : null,
        age_days: days,
        observed_at: best.pick.obs.observed_at,
        promotion_applied: best.promotion_applied,
        promotion_valid_until: best.promotion_applied ? best.pick.obs.promotion_valid_until : null,
        unit_price: unitPrice(best.pick.obs.price_cents, best.product.net_content, best.product.net_content_unit),
      });
      total += best.cost;
      priced += 1;
      if (best.pick.status === 'stale') stale += 1;
      usedSources.add(best.pick.obs.source_id);
      oldestAge = oldestAge === null ? days : Math.max(oldestAge, days);
    }

    const complete = priced === compared.length && total <= BigInt(Number.MAX_SAFE_INTEGER);
    baskets.push({
      chain_id: chainId,
      chain_name: chain.name,
      complete,
      total_cents: complete ? Number(total) : null,
      delta_cents: null,
      priced_count: priced,
      compared_count: compared.length,
      stale_count: stale,
      label: null,
      lines,
    });
  }

  // ---- ranking: complete by total asc (ties: name, id); then incomplete by priced desc ------------------
  const completeBaskets = baskets
    .filter((b) => b.complete)
    .sort((a, b) => a.total_cents! - b.total_cents! || cmpStr(a.chain_name, b.chain_name) || cmpStr(a.chain_id, b.chain_id));
  const incomplete = baskets
    .filter((b) => !b.complete)
    .sort((a, b) => b.priced_count - a.priced_count || cmpStr(a.chain_name, b.chain_name) || cmpStr(a.chain_id, b.chain_id));

  const cheapest = completeBaskets[0];
  if (cheapest) {
    const tied = completeBaskets.filter((b) => b.total_cents === cheapest.total_cents);
    if (completeBaskets.length === 1) cheapest.label = 'only_complete';
    else if (tied.length > 1) for (const b of tied) b.label = 'tied';
    else cheapest.label = 'cheapest';
    for (const b of completeBaskets) if (b.total_cents !== cheapest.total_cents) b.delta_cents = b.total_cents! - cheapest.total_cents!;
  }

  return {
    ...base,
    state: completeBaskets.length > 0 ? 'ranked' : 'no_complete',
    oldest_price_age_days: oldestAge,
    stores: [...completeBaskets, ...incomplete],
    source_ids: [...usedSources].sort(cmpStr),
  };
};
