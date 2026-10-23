/**
 * Helpers for the Node integration tests against the LOCAL Supabase stack (API on :54321, DB on
 * :54322, Mailpit on :54324). Everything goes through the production code paths: supabase-js with
 * real GoTrue users (e-mail OTP), the app's household/auth APIs (src/lib/backend/supabaseApis.ts),
 * the real sync engine with the Node SQLite adapter and the real Supabase transport (RPC + Realtime).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Pool } from 'pg';

import {
  TransientSyncError,
  type ApplyMutationsRequest,
  type ApplyMutationsResponse,
  type ListItemRow,
  type PullChangesResponse,
  type SyncTransport,
  type Uuid,
} from '@/src/contracts';
import { createAuth, createHouseholds } from '@/src/lib/backend/supabaseApis';
import { createSyncEngine } from '@/src/sync/engine';
import { BetterSqliteFactory } from '@/src/sync/node/betterSqlite';
import { wipeLocalData } from '@/src/sync/session';
import { SupabaseSyncTransport } from '@/src/sync/transports/supabase';
import type { GoedSyncEngine } from '@/src/sync/types';
import { ManualConnectivity } from '@/src/sync/util';

export const API_URL = process.env.GB_API_URL ?? 'http://127.0.0.1:54321';
export const MAILPIT_URL = process.env.GB_MAILPIT_URL ?? 'http://127.0.0.1:54324';
export const DB_URL = process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
// The Supabase CLI's fixed local demo keys (`npx supabase status`); overridable.
export const ANON_KEY =
  process.env.GB_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
export const SERVICE_ROLE_KEY =
  process.env.GB_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clients: SupabaseClient[] = [];
export function newClient(): SupabaseClient {
  // Every simulated device gets its own client IP (TEST-NET-2), as phones would: the per-IP invite
  // rate limit (30/h) must not couple independent tests that all run from 127.0.0.1.
  const ip = `198.51.100.${1 + Math.floor(Math.random() * 254)}, 10.0.${clients.length % 250}.1`;
  const c = createClient(API_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-forwarded-for': ip } },
  });
  clients.push(c);
  return c;
}

const admin = createClient(API_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

let pool: Pool | null = null;
/** Superuser connection, only to OBSERVE server truth (never used by the clients under test). */
export function db(): Pool {
  if (!pool) pool = new Pool({ connectionString: DB_URL, max: 4 });
  return pool;
}

export async function closeAll(): Promise<void> {
  for (const c of clients.splice(0)) {
    await c.removeAllChannels().catch(() => undefined);
    c.realtime.disconnect();
  }
  if (pool) await pool.end();
  pool = null;
}

const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let counter = 0;
export function uniqueEmail(label: string): string {
  return `${label}-${run}-${++counter}@example.test`;
}

export interface TestUser {
  id: Uuid;
  email: string;
  client: SupabaseClient;
}

/**
 * A signed-in user via GoTrue's e-mail OTP verification. The 6-digit code is obtained with the admin
 * API (no mail round-trip); `signUpWithMailedCode` below goes through Mailpit like a person would.
 */
export async function signInUser(label: string): Promise<TestUser> {
  const email = uniqueEmail(label);
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw error;
  const client = newClient();
  const v = await client.auth.verifyOtp({ email, token: data.properties.email_otp, type: 'email' });
  if (v.error || !v.data.user) throw v.error ?? new Error('no user');
  return { id: v.data.user.id, email, client };
}

/** Reads the 6-digit code from the newest Mailpit message to `email` (waits up to 10 s). */
export async function readMailedCode(email: string): Promise<{ code: string; subject: string; text: string }> {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=1`);
    const body = (await res.json()) as { messages?: { ID: string; Subject: string }[] };
    const msg = body.messages?.[0];
    if (msg) {
      const full = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${msg.ID}`)).json()) as { Text: string; Subject: string };
      const m = /\b(\d{6})\b/.exec(full.Text);
      if (!m) throw new Error(`no 6-digit code in mail: ${full.Text}`);
      return { code: m[1]!, subject: full.Subject, text: full.Text };
    }
    await sleep(200);
  }
  throw new Error(`no mail for ${email}`);
}

/** Sign-up exactly like the app: AuthApi.sendEmailCode -> mail -> AuthApi.verifyEmailCode. */
export async function signUpWithMailedCode(label: string) {
  const email = uniqueEmail(label);
  const client = newClient();
  const auth = createAuth(client);
  const sent = await auth.sendEmailCode(email);
  if (!sent.ok) throw new Error(`sendEmailCode: ${sent.error}`);
  const mail = await readMailedCode(email);
  const verified = await auth.verifyEmailCode(email, mail.code);
  if (!verified.ok) throw new Error(`verifyEmailCode: ${verified.error}`);
  const user = await auth.getUser();
  if (!user) throw new Error('no session after verify');
  return { user, email, client, auth, households: createHouseholds(client), mail };
}

/** Ensures the user's household like the app does after sign-in (silently creates "Thuis"). */
export async function ensureHousehold(client: SupabaseClient): Promise<Uuid> {
  const r = await createHouseholds(client).createHousehold('Thuis');
  if (!r.ok) throw new Error(`create_household: ${r.error}`);
  return r.household.id;
}

export async function inviteAndJoin(owner: TestUser, joiner: TestUser, householdId: Uuid): Promise<void> {
  const inv = await createHouseholds(owner.client).createInvite(householdId);
  if (!inv.ok) throw new Error(`create_invite: ${inv.error}`);
  await ensureHousehold(joiner.client);
  const acc = await createHouseholds(joiner.client).acceptInvite(inv.code);
  if (!acc.ok) throw new Error(`accept_invite: ${acc.error}`);
}

// ---------------------------------------------------------------------------------------------
// Devices: real engine + Node SQLite file + real Supabase transport, with a network switch
// ---------------------------------------------------------------------------------------------

/**
 * Wraps the real transport with a "network cable": while unplugged every call fails like a dropped
 * connection (TransientSyncError) and realtime nudges are not delivered. Records every apply result.
 */
export class SwitchableTransport implements SyncTransport {
  online = true;
  readonly results: ApplyMutationsResponse[] = [];
  /** When > 0: the request reaches the server, the response is lost (n times). */
  loseResponses = 0;
  constructor(readonly inner: SyncTransport) {}

  async applyMutations(req: ApplyMutationsRequest): Promise<ApplyMutationsResponse> {
    if (!this.online) throw new TransientSyncError('offline');
    const res = await this.inner.applyMutations(req);
    this.results.push(res);
    if (this.loseResponses > 0) {
      this.loseResponses--;
      throw new TransientSyncError('response lost');
    }
    return res;
  }

  async pullChanges(householdId: Uuid, sinceSeq: number, limit?: number): Promise<PullChangesResponse> {
    if (!this.online) throw new TransientSyncError('offline');
    return this.inner.pullChanges(householdId, sinceSeq, limit);
  }

  subscribe(householdId: Uuid, onNudge: (source: 'items' | 'household' | 'membership') => void): () => void {
    return this.inner.subscribe(householdId, (s) => {
      if (this.online) onNudge(s);
    });
  }
}

export interface Device {
  user: TestUser;
  householdId: Uuid;
  engine: GoedSyncEngine;
  transport: SwitchableTransport;
  connectivity: ManualConnectivity;
  factory: BetterSqliteFactory;
  dir: string;
  offline(): void;
  online(): void;
  /** Simulates an app kill: closes the DB handle without any cleanup, then reopens a fresh engine. */
  restart(): Promise<void>;
  /** Visible open + checked rows, projected and sorted for comparison. */
  view(): string[];
  dispose(): Promise<void>;
}

export function tempDir(prefix = 'gb-int-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function openDevice(user: TestUser, householdId: Uuid, opts: { dir?: string; periodicPullMs?: number } = {}): Promise<Device> {
  const dir = opts.dir ?? tempDir();
  const factory = new BetterSqliteFactory(dir);
  const connectivity = new ManualConnectivity(true);
  const transport = new SwitchableTransport(SupabaseSyncTransport.fromClient(user.client, user.id));
  const make = async () => {
    const dbh = await factory.open(user.id);
    const engine = createSyncEngine(
      { db: dbh, transport, connectivity, userId: user.id, householdId, uuid: () => crypto.randomUUID() },
      { pushDebounceMs: 20, nudgeDebounceMs: 20, periodicPullMs: opts.periodicPullMs ?? 60_000 },
    );
    await engine.start();
    return engine;
  };
  const device: Device = {
    user,
    householdId,
    engine: await make(),
    transport,
    connectivity,
    factory,
    dir,
    offline() {
      transport.online = false;
      connectivity.set(false);
    },
    online() {
      transport.online = true;
      connectivity.set(true);
    },
    async restart() {
      // No stop(): like a killed process, timers die with it and the file is just closed.
      const old = device.engine;
      void old.stop().catch(() => undefined);
      device.engine = await make();
    },
    view() {
      const s = device.engine.getSnapshot();
      return projectRows([...s.open, ...s.checked]);
    },
    async dispose() {
      await device.engine.dispose().catch(() => undefined);
    },
  };
  return device;
}

export function projectRows(rows: Pick<ListItemRow, 'id' | 'name' | 'quantity' | 'unit' | 'checked' | 'note'>[]): string[] {
  return rows.map((r) => `${r.id}|${r.name}|${Number(r.quantity)}|${r.unit}|${r.checked ? 'x' : ' '}|${r.note}`).sort();
}

/** Server truth (non-deleted rows of a household), observed with the superuser connection. */
export async function serverRows(householdId: Uuid): Promise<string[]> {
  const { rows } = await db().query(
    `select id, name, quantity::float8 as quantity, unit, checked, note from public.list_items
      where household_id = $1 and deleted_at is null`,
    [householdId],
  );
  return projectRows(rows as ListItemRow[]);
}

/** Pushes everything and pulls until every device's outbox is empty and views stop changing. */
export async function settle(devices: Device[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const d of devices) await d.engine.syncNow();
    for (const d of devices) await d.engine.whenIdle();
    const pending = devices.reduce((n, d) => n + d.engine.getStatus().pendingCount, 0);
    if (pending === 0) {
      for (const d of devices) await d.engine.syncNow();
      return;
    }
    if (Date.now() > deadline) throw new Error(`not settled: ${pending} pending`);
    await sleep(100);
  }
}

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(50);
  }
}

export async function wipeDevice(d: Device): Promise<void> {
  await wipeLocalData({ engine: d.engine, factory: d.factory, userId: d.user.id });
}
