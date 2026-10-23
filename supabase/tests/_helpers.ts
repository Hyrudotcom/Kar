/**
 * Test harness for supabase/tests (jest project `db`, `npm run test:db`).
 * Talks to the local stack with `pg` as `postgres` and impersonates users the way PostgREST does:
 * one transaction per request, `set local role authenticated|anon` + `request.jwt.claims`.
 * Every test creates its own users/households (random ids), so files can share one database.
 * Not a test file (no `.test.`), other db test files (e.g. prices*) may import it.
 */
import { randomUUID } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import type { Mutation, MutationKind, MutationPayloads } from '@/src/contracts';

export const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export const pool = new Pool({ connectionString: DB_URL, max: 10 });

export const uuid = (): string => randomUUID();

export interface RequestOptions {
  /** Client IP as the edge proxy reports it (cf-connecting-ip), for rate limiting per IP. */
  ip?: string;
  /** Raw request headers (overrides ip). */
  headers?: Record<string, string>;
}

/** Run fn inside one transaction as `uid` (authenticated) or, with null, as anon. Commits on success. */
export async function asUser<T>(uid: string | null, fn: (c: PoolClient) => Promise<T>, opts: RequestOptions = {}): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const claims = uid ? { sub: uid, role: 'authenticated', aud: 'authenticated' } : { role: 'anon' };
    await c.query(`select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)`, [
      JSON.stringify(claims),
      JSON.stringify(opts.headers ?? (opts.ip ? { 'cf-connecting-ip': opts.ip } : {})),
    ]);
    await c.query(uid ? 'set local role authenticated' : 'set local role anon');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Same as `asUser`, but always rolls back (for probing writes that must fail or not persist). */
export async function asRollback<T>(uid: string | null, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const claims = uid ? { sub: uid, role: 'authenticated' } : { role: 'anon' };
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await c.query(uid ? 'set local role authenticated' : 'set local role anon');
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

/** Call an RPC with named arguments, like supabase.rpc(name, args). */
export async function rpc<T = any>(
  uid: string | null,
  name: string,
  args: Record<string, unknown> = {},
  opts: RequestOptions = {},
): Promise<T> {
  return asUser(uid, (c) => rpcIn<T>(c, name, args), opts);
}

export async function rpcIn<T = any>(c: PoolClient, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const keys = Object.keys(args);
  const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
  const values = keys.map((k) => {
    const v = args[k];
    return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  });
  const res = await c.query(sql, values);
  return res.rows[0].r as T;
}

/** Superuser-side (postgres) query, bypasses RLS. */
export async function admin<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

let userCounter = 0;
/** Creates an auth user (profile via trigger) and returns its id. */
export async function createUser(displayName?: string): Promise<string> {
  const id = uuid();
  userCounter += 1;
  const name = displayName ?? `Gebruiker ${userCounter}`;
  await admin(
    `insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, $3, '{}', now(), now())`,
    [id, `t-${id}@example.test`, JSON.stringify({ full_name: name })],
  );
  return id;
}

/** User with a fresh household ("Thuis") as owner. */
export async function createUserWithHousehold(displayName?: string): Promise<{ uid: string; hid: string }> {
  const uid = await createUser(displayName);
  const r = await rpc(uid, 'create_household', {});
  if (!r.ok) throw new Error(`create_household failed: ${JSON.stringify(r)}`);
  return { uid, hid: r.household.id };
}

/** Owner + extra members in one household. */
export async function createHousehold(memberCount = 1): Promise<{ hid: string; owner: string; members: string[] }> {
  const { uid: owner, hid } = await createUserWithHousehold('Eigenaar');
  const members: string[] = [];
  for (let i = 1; i < memberCount; i++) {
    const m = await createUser(`Lid ${i}`);
    await addMemberDirect(hid, m);
    members.push(m);
  }
  return { hid, owner, members };
}

/** Joins a user via a real invite (create_invite + accept_invite). */
export async function joinViaInvite(hid: string, inviter: string, joiner: string): Promise<any> {
  const inv = await rpc(inviter, 'create_invite', { p_household_id: hid });
  if (!inv.ok) throw new Error(`create_invite failed: ${JSON.stringify(inv)}`);
  return rpc(joiner, 'accept_invite', { p_code: inv.code });
}

export async function addMemberDirect(hid: string, uid: string): Promise<void> {
  await admin(`insert into public.household_members (household_id, user_id, role) values ($1, $2, 'member')`, [hid, uid]);
}

export function mutation<K extends MutationKind>(
  householdId: string,
  kind: K,
  payload: MutationPayloads[K],
  id: string = uuid(),
): Extract<Mutation, { kind: K }> {
  return { id, household_id: householdId, kind, payload, client_created_at: new Date().toISOString() } as Extract<Mutation, { kind: K }>;
}

export function apply(uid: string | null, householdId: string, mutations: unknown[]): Promise<any> {
  return rpc(uid, 'apply_mutations', { batch: { household_id: householdId, mutations } });
}

/** Adds an item and returns its id (the target id after merge/restore). */
export async function addItem(
  uid: string,
  hid: string,
  name: string,
  quantity = 1,
  unit: MutationPayloads['add_item']['unit'] = 'stuk',
): Promise<string> {
  const r = await apply(uid, hid, [mutation(hid, 'add_item', { id: uuid(), name, quantity, unit })]);
  if (!r.ok || !['applied', 'merged', 'restored'].includes(r.results[0].status)) {
    throw new Error(`addItem failed: ${JSON.stringify(r)}`);
  }
  return r.results[0].item_id;
}

export async function itemRow(id: string): Promise<any> {
  const rows = await admin(`select * from public.list_items where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function lastSeq(hid: string): Promise<number> {
  const rows = await admin<{ last_seq: string }>(`select last_seq from public.households where id = $1`, [hid]);
  return Number(rows[0]?.last_seq ?? NaN);
}

/** Expect a query to fail with a permission error (42501) or RLS violation. */
export async function expectDenied(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|42P01|3F000)$/) });
}

export function closePool(): Promise<void> {
  return pool.end();
}
