/**
 * Price schema, RLS and integrity (owner: price builder). Run with `npm run test:db`.
 * Fixture prices are inserted inside transactions that are ALWAYS rolled back: no price data persists.
 */
import type { PoolClient } from 'pg';
import { compareBaskets } from '@/src/price/engine';
import { isValidGtin } from '@/src/price/ean';
import { listFingerprint } from '@/src/price/fingerprint';
import { loadPriceDataset, type PriceReadClient } from '@/src/price/repository';
import { makeQuery } from '@/src/price/testing';
import { admin, asRollback, asUser, closePool, createHousehold, createUserWithHousehold, expectDenied, pool, uuid } from './_helpers';

afterAll(closePool);

const REFERENCE_TABLES = ['price_sources', 'chains', 'catalog_items', 'products', 'catalog_product_links', 'price_observations'] as const;
const ALL_TABLES = [...REFERENCE_TABLES, 'price_match_overrides'] as const;

/** Runs fn as service_role (ingestion) inside a transaction that is rolled back. */
async function asServiceRollback<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    await c.query('set local role service_role');
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

/** Expect a statement to fail with the given SQLSTATE; uses a savepoint so the transaction survives. */
async function expectSqlState(c: PoolClient, code: string, sql: string, params: unknown[] = []): Promise<void> {
  await c.query('savepoint s');
  try {
    await expect(c.query(sql, params)).rejects.toMatchObject({ code });
  } finally {
    await c.query('rollback to savepoint s');
  }
}

async function insertProduct(c: PoolClient, ean: string, unit = 'ml', content = 1000, chain: string | null = null): Promise<string> {
  const r = await c.query(
    `insert into public.products (ean, chain_id, name, net_content, net_content_unit) values ($1, $2, $3, $4, $5) returning id`,
    [ean, chain, `Product ${ean}`, content, unit],
  );
  return r.rows[0].id;
}

/** GTIN-13 with valid check digit from a 12 digit body. */
function gtin(body12: string): string {
  let sum = 0;
  for (let i = body12.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body12[i]) * w;
  return body12 + ((10 - (sum % 10)) % 10).toString();
}

describe('seed: no prices, only reference rows', () => {
  test('Open Prices is registered but not verified for consumer display', async () => {
    const rows = await admin(`select id, channel, verified_for_consumer_display from public.price_sources`);
    expect(rows).toContainEqual({ id: 'open_prices', channel: 'national', verified_for_consumer_display: false });
    expect(rows.filter((r) => r.verified_for_consumer_display)).toEqual([]);
  });

  test('chains are seeded; no products, links or observations', async () => {
    const chains = await admin(`select id from public.chains order by id`);
    expect(chains.map((r) => r.id)).toEqual(expect.arrayContaining(['ah', 'jumbo', 'plus', 'lidl', 'aldi', 'dirk', 'picnic', 'coop']));
    for (const t of ['products', 'catalog_product_links', 'price_observations']) {
      const [{ n }] = await admin(`select count(*)::int as n from public.${t}`);
      expect({ t, n }).toEqual({ t, n: 0 });
    }
  });

  test('v1 end state: an authenticated user loads the dataset and the engine says unavailable', async () => {
    const { uid } = await createUserWithHousehold();
    const result = await asUser(uid, async (c) => {
      const data = await loadPriceDataset(pgReadClient(c));
      const items = [{ list_item_id: uuid(), name: 'Melk', normalized_name: 'melk', quantity: 1, unit: 'stuk' as const, excluded: false }];
      return compareBaskets({ items, data, now: Date.now(), list_fingerprint: listFingerprint(items) });
    });
    expect(result.state).toBe('unavailable');
    expect(result.stores).toEqual([]);
  });
});

describe('privileges and RLS', () => {
  test('anon cannot read any price table', async () => {
    for (const t of ALL_TABLES) {
      await expectDenied(asRollback(null, (c) => c.query(`select * from public.${t} limit 1`)));
    }
  });

  test('authenticated can read reference tables', async () => {
    const { uid } = await createUserWithHousehold();
    await asUser(uid, async (c) => {
      for (const t of REFERENCE_TABLES) await c.query(`select * from public.${t} limit 1`);
      const r = await c.query(`select id from public.price_sources where id = 'open_prices'`);
      expect(r.rowCount).toBe(1);
    });
  });

  test('authenticated cannot write reference tables', async () => {
    const { uid } = await createUserWithHousehold();
    const writes = [
      `insert into public.price_sources (id, name, licence, channel, verified_for_consumer_display) values ('evil', 'x', 'x', 'national', true)`,
      `update public.price_sources set verified_for_consumer_display = true`,
      `delete from public.price_sources`,
      `insert into public.chains (id, name) values ('evil', 'Evil')`,
      `update public.chains set name = 'x'`,
      `insert into public.catalog_items (id, display_name, reference_quantity, reference_unit) values ('x', 'x', 1, 'stuk')`,
      `insert into public.products (ean, name, net_content, net_content_unit) values ('8712800012078', 'x', 1, 'ml')`,
      `delete from public.products`,
      `insert into public.price_observations (product_id, chain_id, source_id, price_cents) values (gen_random_uuid(), 'ah', 'open_prices', 1)`,
      `update public.price_observations set price_cents = 1`,
      `delete from public.catalog_product_links`,
    ];
    for (const sql of writes) await expectDenied(asRollback(uid, (c) => c.query(sql)));
  });

  test('anon cannot write reference tables', async () => {
    await expectDenied(asRollback(null, (c) => c.query(`update public.price_sources set verified_for_consumer_display = true`)));
  });

  test('anon and authenticated cannot call the trigger functions', async () => {
    const { uid } = await createUserWithHousehold();
    await expectDenied(asRollback(uid, (c) => c.query(`select private.prices_links_check()`)));
  });

  test('gb_valid_gtin is not callable by anon', async () => {
    await expectDenied(asRollback(null, (c) => c.query(`select public.gb_valid_gtin('8712800012078')`)));
  });
});

describe('"Verkeerd product" overrides: strict household separation', () => {
  let A: { hid: string; owner: string; members: string[] };
  let B: { hid: string; owner: string; members: string[] };
  const catalogId = `test-item-${uuid().slice(0, 8)}`;

  beforeAll(async () => {
    A = await createHousehold(2);
    B = await createHousehold(1);
    // a catalog item is reference data, not a price; removed again in afterAll
    await admin(`insert into public.catalog_items (id, display_name, aliases, reference_quantity, reference_unit) values ($1, 'Test', '{}', 1, 'stuk')`, [catalogId]);
  });
  afterAll(async () => {
    await admin(`delete from public.catalog_items where id = $1`, [catalogId]);
  });

  test('a member inserts for their own household; created_by is set by the server', async () => {
    await asUser(A.members[0]!, (c) =>
      c.query(`insert into public.price_match_overrides (household_id, catalog_item_id, chain_id) values ($1, $2, 'ah')`, [A.hid, catalogId]),
    );
    const rows = await admin(`select created_by from public.price_match_overrides where household_id = $1 and catalog_item_id = $2`, [A.hid, catalogId]);
    expect(rows).toEqual([{ created_by: A.members[0] }]);
    // visible to the whole household
    const seen = await asUser(A.owner, (c) => c.query(`select household_id from public.price_match_overrides where catalog_item_id = $1`, [catalogId]));
    expect(seen.rows).toEqual([{ household_id: A.hid }]);
  });

  test('B cannot see, insert into or delete A’s overrides', async () => {
    const seen = await asUser(B.owner, (c) => c.query(`select * from public.price_match_overrides where household_id = $1`, [A.hid]));
    expect(seen.rowCount).toBe(0);
    await expect(
      asRollback(B.owner, (c) =>
        c.query(`insert into public.price_match_overrides (household_id, catalog_item_id, chain_id) values ($1, $2, 'jumbo')`, [A.hid, catalogId]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const del = await asUser(B.owner, (c) => c.query(`delete from public.price_match_overrides where household_id = $1`, [A.hid]));
    expect(del.rowCount).toBe(0);
    const still = await admin(`select count(*)::int as n from public.price_match_overrides where household_id = $1`, [A.hid]);
    expect(still[0].n).toBe(1);
  });

  test('clients cannot forge created_by / created_at or update rows', async () => {
    await expectDenied(
      asRollback(A.owner, (c) =>
        c.query(`insert into public.price_match_overrides (household_id, catalog_item_id, chain_id, created_by) values ($1, $2, 'plus', $3)`, [A.hid, catalogId, B.owner]),
      ),
    );
    await expectDenied(asRollback(A.owner, (c) => c.query(`update public.price_match_overrides set chain_id = 'plus' where household_id = $1`, [A.hid])));
  });

  test('anon cannot insert overrides', async () => {
    await expectDenied(
      asRollback(null, (c) =>
        c.query(`insert into public.price_match_overrides (household_id, catalog_item_id, chain_id) values ($1, $2, 'ah')`, [A.hid, catalogId]),
      ),
    );
  });

  test('"Toch gebruiken": a member deletes the override again', async () => {
    const del = await asUser(A.owner, (c) => c.query(`delete from public.price_match_overrides where household_id = $1 and catalog_item_id = $2`, [A.hid, catalogId]));
    expect(del.rowCount).toBe(1);
  });
});

describe('integrity (service_role ingestion, rolled back)', () => {
  test('a price of 0 or below is impossible; unknown = no row', async () => {
    await asServiceRollback(async (c) => {
      const p = await insertProduct(c, '8712800012078');
      await expectSqlState(c, '23514', `insert into public.price_observations (product_id, chain_id, source_id, price_cents) values ($1, 'ah', 'open_prices', 0)`, [p]);
      await expectSqlState(c, '23514', `insert into public.price_observations (product_id, chain_id, source_id, price_cents) values ($1, 'ah', 'open_prices', -5)`, [p]);
      await expectSqlState(c, '23502', `insert into public.price_observations (product_id, chain_id, source_id, price_cents) values ($1, 'ah', 'open_prices', null)`, [p]);
    });
  });

  test('EAN must be a valid GTIN; (ean, chain) unique with null chain counted once', async () => {
    await asServiceRollback(async (c) => {
      await expectSqlState(c, '23514', `insert into public.products (ean, name, net_content, net_content_unit) values ('8712800012079', 'x', 1, 'ml')`);
      await expectSqlState(c, '23514', `insert into public.products (ean, name, net_content, net_content_unit) values ('12345', 'x', 1, 'ml')`);
      await insertProduct(c, '8712800012078');
      await expectSqlState(c, '23505', `insert into public.products (ean, name, net_content, net_content_unit) values ('8712800012078', 'dup', 1, 'ml')`);
      // same EAN as a private label of a chain is a different row
      await insertProduct(c, '8712800012078', 'ml', 1000, 'ah');
    });
  });

  test('SQL gb_valid_gtin equals TS isValidGtin', async () => {
    const vectors = ['8712800012078', '8712800012077', '96385074', '96385075', '036000291452', '10012345678902', '871280001207', 'abc', '', '00000000'];
    const r = await admin<{ v: string; ok: boolean }>(`select v, public.gb_valid_gtin(v) as ok from unnest($1::text[]) as v`, [vectors]);
    for (const row of r) expect({ v: row.v, ok: row.ok }).toEqual({ v: row.v, ok: isValidGtin(row.v) });
  });

  test('links: unit must match the catalog item, private label only at its own chain', async () => {
    await asServiceRollback(async (c) => {
      await c.query(`insert into public.catalog_items (id, display_name, aliases, reference_quantity, reference_unit) values ('bananen-test', 'Bananen', '{"Bananen test"}', 1000, 'g')`);
      const tros = await insertProduct(c, gtin('200000000013'), 'stuk', 5);
      const perKg = await insertProduct(c, gtin('200000000014'), 'g', 1000);
      const ahBrood = await insertProduct(c, gtin('200000000015'), 'g', 800, 'ah');
      const link = `insert into public.catalog_product_links (catalog_item_id, chain_id, product_id, confidence, approved_by) values ('bananen-test', $1, $2, 1, 'test')`;
      await expectSqlState(c, '23514', link, ['ah', tros]);
      await c.query(link, ['ah', perKg]);
      await c.query(link, ['ah', ahBrood]);
      await expectSqlState(c, '23514', link, ['jumbo', ahBrood]);
      // changing a linked product's unit or a catalog item's unit is refused
      await expectSqlState(c, '23514', `update public.products set net_content_unit = 'stuk' where id = $1`, [perKg]);
      await expectSqlState(c, '23514', `update public.catalog_items set reference_unit = 'stuk' where id = 'bananen-test'`);
      await expectSqlState(c, '23514', `update public.products set chain_id = 'jumbo' where id = $1`, [ahBrood]);
      await expectSqlState(c, '23514', `insert into public.catalog_product_links (catalog_item_id, chain_id, product_id, confidence, approved_by) values ('bananen-test', 'ah', $1, 1.5, 'x')`, [perKg]);
    });
  });

  test('observations: private label only at its own chain; no future observed_at; promotion shape', async () => {
    await asServiceRollback(async (c) => {
      const ahBrood = await insertProduct(c, gtin('200000000016'), 'g', 800, 'ah');
      const obs = `insert into public.price_observations (product_id, chain_id, source_id, price_cents, observed_at, promotion, promotion_valid_until) values ($1, $2, 'open_prices', 229, $3, $4, $5)`;
      await c.query(obs, [ahBrood, 'ah', new Date().toISOString(), null, null]);
      await c.query(obs, [ahBrood, 'ah', null, null, null]); // unknown observed_at is storable
      await expectSqlState(c, '23514', obs, [ahBrood, 'jumbo', new Date().toISOString(), null, null]);
      await expectSqlState(c, '23514', obs, [ahBrood, 'ah', new Date(Date.now() + 86_400_000).toISOString(), null, null]);
      const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
      await c.query(obs, [ahBrood, 'ah', null, JSON.stringify({ type: 'multi_buy', min_quantity: 2, total_cents: 300 }), until]);
      await c.query(obs, [ahBrood, 'ah', null, JSON.stringify({ type: 'x_plus_y', buy: 1, free: 1 }), until]);
      for (const bad of [{ type: 'multi_buy', min_quantity: 1, total_cents: 300 }, { type: 'x_plus_y', buy: 1, free: 0 }, { type: 'korting', pct: 50 }, { type: 'multi_buy', min_quantity: '2', total_cents: 300 }, [1]]) {
        await expectSqlState(c, '23514', obs, [ahBrood, 'ah', null, JSON.stringify(bad), until]);
      }
      await expectSqlState(c, '23514', obs, [ahBrood, 'ah', null, null, until]); // validity without promotion
      await expectSqlState(
        c,
        '23514',
        `insert into public.price_observations (product_id, chain_id, source_id, price_cents, unit_price_cents) values ($1, 'ah', 'open_prices', 229, 286)`,
        [ahBrood],
      );
    });
  });

  test('catalog aliases are normalized and one alias belongs to one catalog item', async () => {
    await asServiceRollback(async (c) => {
      const r = await c.query(
        `insert into public.catalog_items (id, display_name, aliases, reference_quantity, reference_unit) values ('creme-test', 'Crème', $1, 200, 'ml') returning aliases`,
        [['  Crème   Fraîche ', 'creme fraiche', '']],
      );
      expect(r.rows[0].aliases).toEqual(['creme fraiche']);
      await expectSqlState(c, '23505', `insert into public.catalog_items (id, display_name, aliases, reference_quantity, reference_unit) values ('creme-test-2', 'x', '{"CREME FRAICHE"}', 1, 'ml')`);
    });
  });
});

describe('end to end with fixture prices (rolled back)', () => {
  test('authenticated read -> engine: complete basket ranked, unknown never 0, override makes store incomplete', async () => {
    const { uid, hid } = await createUserWithHousehold();
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role service_role');
      await c.query(`insert into public.price_sources (id, name, licence, channel, verified_for_consumer_display) values ('test_feed', 'Testfeed', 'test', 'webshop', true)`);
      await c.query(`insert into public.catalog_items (id, display_name, aliases, reference_quantity, reference_unit) values ('melk-test', 'Melk', '{"melk e2e"}', 1000, 'ml'), ('kaas-test', 'Kaas', '{"kaas e2e"}', 500, 'g')`);
      const melk = await insertProduct(c, gtin('200000000017'), 'ml', 1000);
      const kaas = await insertProduct(c, gtin('200000000018'), 'g', 500);
      for (const chain of ['ah', 'jumbo']) {
        await c.query(`insert into public.catalog_product_links (catalog_item_id, chain_id, product_id, confidence, approved_by) values ('melk-test', $1, $2, 1, 'test'), ('kaas-test', $1, $3, 0.95, 'test')`, [chain, melk, kaas]);
      }
      const obs = `insert into public.price_observations (product_id, chain_id, source_id, price_cents, observed_at) values ($1, $2, 'test_feed', $3, now() - interval '1 day')`;
      await c.query(obs, [melk, 'ah', 119]);
      await c.query(obs, [melk, 'jumbo', 115]);
      await c.query(obs, [kaas, 'ah', 650]);
      await c.query(obs, [kaas, 'jumbo', 699]);
      await c.query('reset role');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
      await c.query('set local role authenticated');

      const items = [
        { list_item_id: uuid(), name: 'Melk e2e', normalized_name: 'melk e2e', quantity: 1.5, unit: 'l' as const, excluded: false },
        { list_item_id: uuid(), name: 'Kaas e2e', normalized_name: 'kaas e2e', quantity: 1, unit: 'stuk' as const, excluded: false },
      ];
      const run = async () => compareBaskets({ items, data: await loadPriceDataset(pgReadClient(c), { householdId: hid }), now: Date.now(), list_fingerprint: listFingerprint(items) });

      const r1 = await run();
      expect(r1.state).toBe('ranked');
      expect(r1.stores.map((s) => [s.chain_id, s.total_cents, s.label])).toEqual([
        ['ah', 2 * 119 + 650, 'cheapest'],
        ['jumbo', 2 * 115 + 699, null],
      ]);

      await c.query(`insert into public.price_match_overrides (household_id, catalog_item_id, chain_id) values ($1, 'kaas-test', 'ah')`, [hid]);
      const r2 = await run();
      expect(r2.stores.map((s) => [s.chain_id, s.complete, s.total_cents, s.label])).toEqual([
        ['jumbo', true, 2 * 115 + 699, 'only_complete'],
        ['ah', false, null, null],
      ]);
      const kaasAh = r2.stores[1]!.lines[1]!;
      expect(kaasAh).toMatchObject({ status: 'unknown', line_total_cents: null });
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
    const [{ n }] = await admin(`select count(*)::int as n from public.price_observations`);
    expect(n).toBe(0);
  });
});

describe('price_observations_latest (rolled back)', () => {
  test('one row per product and chain: the newest usable one; more than 1000 rows load in pages', async () => {
    const { uid } = await createUserWithHousehold();
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query('set local role service_role');
      await c.query(`insert into public.price_sources (id, name, licence, channel, verified_for_consumer_display) values ('test_feed', 'Testfeed', 'test', 'webshop', true), ('test_raw', 'Ruw', 'test', 'webshop', false)`);
      await c.query(`insert into public.catalog_items (id, display_name, aliases, reference_quantity, reference_unit) values ('melk-view', 'Melk', '{"melk view"}', 1000, 'ml')`);
      const eans = Array.from({ length: 1100 }, (_, i) => gtin(`21${i.toString().padStart(10, '0')}`));
      const ids: string[] = (
        await c.query(
          `insert into public.products (ean, name, net_content, net_content_unit) select e, 'P ' || e, 1000, 'ml' from unnest($1::text[]) e returning id`,
          [eans],
        )
      ).rows.map((r) => r.id);
      await c.query(
        `insert into public.catalog_product_links (catalog_item_id, chain_id, product_id, confidence, approved_by) select 'melk-view', 'ah', p, 1, 'test' from unnest($1::uuid[]) p`,
        [ids],
      );
      // Every product: an old and a new price at AH.
      await c.query(
        `insert into public.price_observations (product_id, chain_id, source_id, price_cents, observed_at)
         select p, 'ah', 'test_feed', 200, now() - interval '3 days' from unnest($1::uuid[]) p
         union all select p, 'ah', 'test_feed', 100, now() - interval '1 day' from unnest($1::uuid[]) p`,
        [ids],
      );
      const first = ids[0]!;
      const obs = `insert into public.price_observations (product_id, chain_id, source_id, price_cents, observed_at, requires_loyalty) values ($1, $2, $3, $4, now() - $5::interval, $6)`;
      await c.query(obs, [first, 'ah', 'test_feed', 50, '1 hour', true]); // newer, but loyalty only
      await c.query(obs, [first, 'ah', 'test_raw', 40, '1 hour', false]); // newer, but not verified
      await c.query(obs, [first, 'jumbo', 'test_feed', 99, '1 hour', false]); // no link at Jumbo
      await c.query(obs, [ids[1]!, 'ah', 'test_feed', 30, '1 minute', false]); // newest: used
      await c.query(`delete from public.price_observations where product_id = $1 and observed_at > now() - interval '2 days'`, [ids[2]!]);
      await c.query(`update public.price_observations set observed_at = now() - interval '20 days' where product_id = $1`, [ids[2]!]);
      await c.query('reset role');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
      await c.query('set local role authenticated');

      const rows = (await c.query(`select product_id, chain_id, price_cents from public.price_observations_latest`)).rows;
      expect(rows).toHaveLength(1099); // ids[2] only has a 20 day old price
      const byProduct = new Map(rows.map((r) => [r.product_id, r]));
      expect(byProduct.get(first)).toMatchObject({ chain_id: 'ah', price_cents: 100 });
      expect(byProduct.get(ids[1]!)).toMatchObject({ price_cents: 30 });
      expect(byProduct.has(ids[2]!)).toBe(false);

      const data = await loadPriceDataset(pgReadClient(c));
      expect(data.observations).toHaveLength(1099);
      expect(data.products.length).toBeGreaterThanOrEqual(1100);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  });

  test('anon cannot read the view', async () => {
    await asUser(null, async (c) => {
      await expect(c.query('select 1 from public.price_observations_latest limit 1')).rejects.toMatchObject({ code: '42501' });
    });
  });
});

/** PriceReadClient over a pg connection that mimics PostgREST output (timestamps as ISO strings, max_rows cut). */
function pgReadClient(c: PoolClient, maxRows = 1000): PriceReadClient {
  let queue: Promise<unknown> = Promise.resolve(); // one pg connection runs one query at a time
  return {
    from(table) {
      return {
        select(columns, options) {
          return makeQuery((spec) => {
            const run = async () => {
              const ident = /^[a-z_]+$/;
              if (!ident.test(table) || !/^[a-z_,]+$/.test(columns) || !spec.order.every((o) => ident.test(o))) throw new Error('bad identifier');
              try {
                const order = spec.order.length ? ` order by ${spec.order.join(', ')}` : '';
                const limit = Math.min(spec.to - spec.from + 1, maxRows);
                const r = await c.query(`select ${columns}, count(*) over () as __total from public.${table}${order} limit $1 offset $2`, [limit, spec.from]);
                const data = r.rows.map((row) =>
                  Object.fromEntries(
                    Object.entries(row)
                      .filter(([k]) => k !== '__total')
                      .map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
                  ),
                );
                let count: number | null = null;
                if (options?.count === 'exact') {
                  count = r.rows.length ? Number(r.rows[0].__total) : Number((await c.query(`select count(*)::int as n from public.${table}`)).rows[0].n);
                }
                return { data, error: null, count };
              } catch (e) {
                return { data: null, error: { message: (e as Error).message } };
              }
            };
            const p = queue.then(run, run);
            queue = p;
            return p;
          });
        },
      };
    },
  };
}
