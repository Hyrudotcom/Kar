/**
 * (d) Household separation through the public API (PostgREST tables, RPCs and Realtime) with real
 * users: a user of household B cannot read, write or subscribe to anything of household A, and a
 * removed member loses access immediately and its local data is wiped.
 */
import fs from 'node:fs';

import type { RealtimeChannel } from '@supabase/supabase-js';

import type { Uuid } from '@/src/contracts';
import { createHouseholds } from '@/src/lib/backend/supabaseApis';

import {
  closeAll,
  db,
  ensureHousehold,
  newClient,
  openDevice,
  serverRows,
  settle,
  signInUser,
  sleep,
  waitFor,
  wipeDevice,
  type Device,
  type TestUser,
} from './stack';

jest.setTimeout(120_000);
afterAll(closeAll);

let devices: Device[] = [];
afterEach(async () => {
  for (const d of devices) await d.dispose();
  devices = [];
});

interface World {
  anna: TestUser;
  bram: TestUser;
  eve: TestUser;
  hhA: Uuid;
  hhB: Uuid;
  annaDevice: Device;
  itemA: Uuid;
}

async function world(): Promise<World> {
  const anna = await signInUser('sep-anna');
  const bram = await signInUser('sep-bram');
  const eve = await signInUser('sep-eve');
  const hhA = await ensureHousehold(anna.client);
  const hhB = await ensureHousehold(eve.client);
  const inv = await createHouseholds(anna.client).createInvite(hhA);
  if (!inv.ok) throw new Error(inv.error);
  await ensureHousehold(bram.client);
  const acc = await createHouseholds(bram.client).acceptInvite(inv.code);
  if (!acc.ok) throw new Error(acc.error);
  const annaDevice = await openDevice(anna, hhA);
  devices.push(annaDevice);
  await annaDevice.engine.addItem({ name: 'Geheime taart', quantity: 1, unit: 'stuk', note: 'verjaardag Bram' });
  await settle([annaDevice]);
  const itemA = annaDevice.engine.getSnapshot().open[0]!.id;
  return { anna, bram, eve, hhA, hhB, annaDevice, itemA };
}

/** Subscribes to every realtime feed that would reveal household A, and records what arrives. */
function spy(user: TestUser, hhA: Uuid, foreignUserId: Uuid) {
  const events: string[] = [];
  const statuses: Record<string, string> = {};
  const ch: RealtimeChannel[] = [];
  ch.push(
    user.client
      .channel(`spy-items-${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'list_items', filter: `household_id=eq.${hhA}` }, (p) =>
        events.push(`list_items:${p.eventType}`),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'list_items' }, (p) => events.push(`list_items(any):${p.eventType}`))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'households', filter: `id=eq.${hhA}` }, (p) => events.push(`households:${p.eventType}`))
      .subscribe((s) => (statuses.changes = s)),
  );
  ch.push(
    user.client
      .channel(`user:${foreignUserId}`, { config: { private: true } })
      .on('broadcast', { event: 'membership_changed' }, (m) => events.push(`broadcast:${JSON.stringify(m.payload)}`))
      .subscribe((s) => (statuses.foreignTopic = s)),
  );
  return {
    events,
    statuses,
    close: async () => {
      for (const c of ch) await user.client.removeChannel(c);
    },
  };
}

describe('(d) household separation', () => {
  test('a user of household B cannot read A through any table', async () => {
    const w = await world();
    const sb = w.eve.client;
    for (const [table, col] of [
      ['list_items', 'household_id'],
      ['household_members', 'household_id'],
      ['households', 'id'],
      ['price_match_overrides', 'household_id'],
    ] as const) {
      const { data, error } = await sb.from(table).select('*').eq(col, w.hhA);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
    const byId = await sb.from('list_items').select('*').eq('id', w.itemA);
    expect(byId.data).toEqual([]);
    // Everything Eve can see is her own.
    const hh = await sb.from('households').select('id');
    expect(hh.data).toEqual([{ id: w.hhB }]);
    const profiles = await sb.from('profiles').select('user_id');
    expect(profiles.data).toEqual([{ user_id: w.eve.id }]);
    // invites: no client access at all, not even for members.
    for (const u of [w.eve, w.anna]) {
      const inv = await u.client.from('invites').select('*');
      expect(inv.error?.code).toBe('42501');
    }
    // anon sees nothing either.
    const anon = newClient();
    const a = await anon.from('list_items').select('*');
    expect(a.error?.code).toBe('42501');
  });

  test('a user of household B cannot write A directly or through RPCs, and guessed ids leak nothing', async () => {
    const w = await world();
    const sb = w.eve.client;
    const ins = await sb.from('list_items').insert({ household_id: w.hhA, name: 'x', quantity: 1, unit: 'stuk' });
    expect(ins.error?.code).toBe('42501');
    const upd = await sb.from('list_items').update({ name: 'gehackt' }).eq('id', w.itemA).select();
    expect(upd.error?.code ?? 'no-rows').toMatch(/42501|no-rows/);
    if (!upd.error) expect(upd.data).toEqual([]);
    const del = await sb.from('list_items').delete().eq('id', w.itemA).select();
    expect(del.error?.code ?? 'no-rows').toMatch(/42501|no-rows/);
    const member = await sb.from('household_members').insert({ household_id: w.hhA, user_id: w.eve.id, role: 'member' });
    expect(member.error?.code).toBe('42501');
    const ovr = await sb.from('price_match_overrides').insert({ household_id: w.hhA, catalog_item_id: 'x', chain_id: 'ah' });
    expect(ovr.error).not.toBeNull();

    const now = new Date().toISOString();
    const pull = await sb.rpc('pull_changes', { p_household_id: w.hhA, p_since_seq: 0 });
    expect(pull.data).toEqual({ ok: false, error: 'not_member' });
    const push = await sb.rpc('apply_mutations', {
      batch: { household_id: w.hhA, mutations: [{ id: crypto.randomUUID(), household_id: w.hhA, kind: 'delete_item', client_created_at: now, payload: { item_id: w.itemA } }] },
    });
    expect(push.data).toEqual({ ok: false, error: 'not_member' });
    // Batch for her own household that smuggles A's household id or A's item id.
    const smuggle = await sb.rpc('apply_mutations', {
      batch: {
        household_id: w.hhB,
        mutations: [
          { id: crypto.randomUUID(), household_id: w.hhA, kind: 'delete_item', client_created_at: now, payload: { item_id: w.itemA } },
          { id: crypto.randomUUID(), household_id: w.hhB, kind: 'add_item', client_created_at: now, payload: { id: w.itemA, name: 'Geheime taart', quantity: 1, unit: 'stuk', note: '' } },
          { id: crypto.randomUUID(), household_id: w.hhB, kind: 'update_item', client_created_at: now, payload: { item_id: w.itemA, fields: { name: 'gehackt' } } },
          { id: crypto.randomUUID(), household_id: w.hhB, kind: 'delete_item', client_created_at: now, payload: { item_id: w.itemA } },
          { id: crypto.randomUUID(), household_id: w.hhB, kind: 'clear_checked', client_created_at: now, payload: { item_ids: [w.itemA] } },
        ],
      },
    });
    const results = (smuggle.data as { results: { status: string; reason?: string; item_id?: string; item?: unknown }[] }).results;
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'applied']);
    expect(results[0]!.reason).toBe('forbidden');
    expect(results[1]!.reason).toBe('invalid');
    expect((results[4] as { affected_ids?: string[] }).affected_ids).toEqual([]);
    // No row data of A in any answer.
    expect(JSON.stringify(smuggle.data)).not.toContain('Geheime');
    expect(JSON.stringify(smuggle.data)).not.toContain('verjaardag');
    // Replaying Anna's own mutation ids from Eve's account is rejected, never replayed.
    const { rows } = await db().query('select id from private.mutations where user_id = $1 limit 1', [w.anna.id]);
    const replay = await sb.rpc('apply_mutations', {
      batch: { household_id: w.hhB, mutations: [{ id: rows[0].id, household_id: w.hhB, kind: 'add_item', client_created_at: now, payload: { id: crypto.randomUUID(), name: 'x', quantity: 1, unit: 'stuk', note: '' } }] },
    });
    expect((replay.data as { results: { status: string; replayed?: boolean }[] }).results[0]).toMatchObject({ status: 'rejected' });
    expect(JSON.stringify(replay.data)).not.toContain('Geheime');

    const hh = createHouseholds(sb);
    expect(await hh.createInvite(w.hhA)).toMatchObject({ ok: false, error: 'not_member' });
    expect(await hh.renameHousehold(w.hhA, 'Van Eve')).toMatchObject({ ok: false });
    expect(await hh.removeMember(w.hhA, w.bram.id)).toMatchObject({ ok: false });
    expect(await hh.leaveHousehold(w.hhA)).toMatchObject({ ok: false, error: 'not_member' });
    const mine = await hh.getMyHousehold();
    expect(mine.ok && mine.household?.id).toBe(w.hhB);

    // A is untouched.
    expect(await serverRows(w.hhA)).toEqual([`${w.itemA}|Geheime taart|1|stuk| |verjaardag Bram`]);
    const names = await db().query('select name from public.households where id = $1', [w.hhA]);
    expect(names.rows[0].name).toBe('Thuis');

    // An engine pointed at A by a forged household id gets nothing and reports membership loss.
    const forged = await openDevice(w.eve, w.hhA);
    devices.push(forged);
    let lost = 0;
    forged.engine.onMembershipLost(() => lost++);
    await forged.engine.syncNow();
    await waitFor(() => lost === 1, 5_000, 'membership lost');
    expect(forged.view()).toEqual([]);
  });

  test('a user of household B cannot subscribe to A in Realtime (positive control: a member receives the events)', async () => {
    const w = await world();
    const eveSpy = spy(w.eve, w.hhA, w.anna.id);
    const bramSpy = spy(w.bram, w.hhA, w.anna.id);
    const bramOwn = w.bram.client
      .channel(`user:${w.bram.id}`, { config: { private: true } })
      .on('broadcast', { event: 'membership_changed' }, (m) => bramSpy.events.push(`own-broadcast:${(m.payload as { reason: string }).reason}`))
      .subscribe((s) => (bramSpy.statuses.ownTopic = s));
    await waitFor(() => eveSpy.statuses.changes === 'SUBSCRIBED' && bramSpy.statuses.changes === 'SUBSCRIBED' && bramSpy.statuses.ownTopic === 'SUBSCRIBED', 10_000, 'subscriptions');
    await sleep(500);

    await w.annaDevice.engine.addItem({ name: 'Kaarsjes', quantity: 10, unit: 'stuk' });
    await w.annaDevice.engine.setChecked(w.itemA, true);
    await settle([w.annaDevice]);
    expect(await createHouseholds(w.anna.client).renameHousehold(w.hhA, 'Huize Anna')).toMatchObject({ ok: true });
    // Realtime checks RLS when it delivers, so wait for the member's events before removing him.
    await waitFor(
      () => ['list_items:INSERT', 'list_items:UPDATE', 'households:UPDATE'].every((e) => bramSpy.events.includes(e)),
      10_000,
      `member receives the events (got ${JSON.stringify(bramSpy.events)})`,
    );
    expect(await createHouseholds(w.anna.client).removeMember(w.hhA, w.bram.id)).toMatchObject({ ok: true });
    await waitFor(() => bramSpy.events.some((e) => e === 'own-broadcast:removed'), 10_000, 'removal broadcast to Bram');
    await sleep(1_500);
    expect(bramSpy.events).toEqual(expect.arrayContaining(['list_items:INSERT', 'list_items:UPDATE', 'households:UPDATE']));
    // Eve: nothing at all, and she cannot join Anna's private topic.
    expect(eveSpy.events).toEqual([]);
    expect(eveSpy.statuses.foreignTopic).not.toBe('SUBSCRIBED');
    // Bram cannot join Anna's private topic either.
    expect(bramSpy.statuses.foreignTopic).not.toBe('SUBSCRIBED');
    expect(bramSpy.events.some((e) => e.startsWith('broadcast:'))).toBe(false);

    // After the removal Bram's feeds of A go quiet.
    const before = bramSpy.events.length;
    await w.annaDevice.engine.addItem({ name: 'Slingers', quantity: 1, unit: 'stuk' });
    await settle([w.annaDevice]);
    await sleep(2_000);
    expect(bramSpy.events.slice(before)).toEqual([]);
    expect(eveSpy.events).toEqual([]);

    // Hard deletes (tombstone purge, household deletion) are not RLS-filtered by Realtime, so the
    // publication sends no deletes at all: Eve's unfiltered feeds stay quiet.
    await db().query('delete from public.list_items where id = $1', [w.itemA]);
    await sleep(2_000);
    expect(eveSpy.events).toEqual([]);
    await eveSpy.close();
    await bramSpy.close();
    await w.bram.client.removeChannel(bramOwn);
  });

  test('an idle, online member who is removed notices within seconds through Realtime alone', async () => {
    const w = await world();
    const bramDevice = await openDevice(w.bram, w.hhA, { periodicPullMs: 10 * 60_000 });
    devices.push(bramDevice);
    await settle([bramDevice]);
    let lost = 0;
    bramDevice.engine.onMembershipLost(() => lost++);
    await sleep(1_000); // channels joined
    const pullsBefore = bramDevice.transport.results.length;
    expect(await createHouseholds(w.anna.client).removeMember(w.hhA, w.bram.id)).toMatchObject({ ok: true });
    // No command, no reconnect, safety pull 10 min away: only the realtime nudge can trigger this.
    await waitFor(() => lost === 1, 10_000, 'membership lost via realtime');
    expect(bramDevice.transport.results.length).toBe(pullsBefore); // nothing was pushed
    expect(bramDevice.engine.getStatus().failed).toEqual([]);
  });

  test('a removed member loses access at once (with unsent changes), unsent changes are reported, local data is wiped', async () => {
    const w = await world();
    const bramDevice = await openDevice(w.bram, w.hhA);
    devices.push(bramDevice);
    await settle([bramDevice]);
    expect(bramDevice.view()).toEqual(await serverRows(w.hhA));
    let lost = 0;
    bramDevice.engine.onMembershipLost(() => lost++);

    // An edit that cannot reach the server before the removal.
    bramDevice.offline();
    await bramDevice.engine.addItem({ name: 'Cadeau voor Anna', quantity: 1, unit: 'stuk' });
    const code = await createHouseholds(w.anna.client).createInvite(w.hhA);
    expect(await createHouseholds(w.anna.client).removeMember(w.hhA, w.bram.id)).toMatchObject({ ok: true, invite_revoked: true });
    bramDevice.online();
    // Reconnecting pushes the outbox, which answers not_member.
    await waitFor(() => lost === 1, 10_000, 'membership lost');
    const status = bramDevice.engine.getStatus();
    expect(status.failed.map((f) => [f.itemName, f.reason])).toEqual([['Cadeau voor Anna', 'not_member']]);
    expect(bramDevice.engine.failedAsText()).toContain('Cadeau voor Anna');
    expect(await serverRows(w.hhA)).not.toEqual(expect.arrayContaining([expect.stringContaining('Cadeau')]));

    // The app's removal flow wipes the per-user database.
    const file = bramDevice.factory.fileFor(w.bram.id);
    await wipeDevice(bramDevice);
    devices = devices.filter((d) => d !== bramDevice);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}-wal`)).toBe(false);

    // No access any more through tables or RPCs.
    expect((await w.bram.client.from('list_items').select('id').eq('household_id', w.hhA)).data).toEqual([]);
    expect((await w.bram.client.rpc('pull_changes', { p_household_id: w.hhA, p_since_seq: 0 })).data).toEqual({ ok: false, error: 'not_member' });
    // The invite code Bram might have kept is revoked.
    if (code.ok) {
      const p = await createHouseholds(w.bram.client).previewInvite(code.code);
      expect(p.ok).toBe(false);
    }
    // Continue after removal: a fresh, empty "Thuis".
    const fresh = await ensureHousehold(w.bram.client);
    expect(fresh).not.toBe(w.hhA);
    const again = await openDevice(w.bram, fresh);
    devices.push(again);
    await settle([again]);
    expect(again.view()).toEqual([]);
  });
});
