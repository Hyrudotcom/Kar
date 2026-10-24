/**
 * (e) Full journey on the local stack, through the app's own auth/household APIs and the real sync
 * engine: sign up with the mailed 6-digit code -> "Thuis" is created silently -> invite -> partner
 * signs up and joins (his solo list moves along) -> both edit -> partner leaves.
 */
import fs from 'node:fs';

import type { RealtimeChannel } from '@supabase/supabase-js';

import {
  closeAll,
  db,
  newClient,
  openDevice,
  serverRows,
  settle,
  signUpWithMailedCode,
  sleep,
  waitFor,
  wipeDevice,
  type Device,
  type TestUser,
} from './stack';

jest.setTimeout(180_000);

async function track(p: Promise<Device>): Promise<Device> {
  const d = await p;
  opened.push(d);
  return d;
}
afterAll(closeAll);

const names = (d: Device) =>
  d
    .view()
    .map((r) => r.split('|').slice(1, 5).join('|'))
    .sort();

const opened: Device[] = [];
afterEach(async () => {
  for (const d of opened.splice(0)) await d.dispose();
});

test('(e) sign up -> Thuis -> invite -> partner joins -> both edit -> partner leaves', async () => {
  // 1. Anna signs up with the code from the e-mail (Dutch template, code only, no magic link).
  const anna = await signUpWithMailedCode('journey-anna');
  expect(anna.mail.subject).toBe('Je inlogcode voor Kar');
  expect(anna.mail.text).not.toMatch(/https?:\/\//);
  const annaUser: TestUser = { id: anna.user.id, email: anna.email, client: anna.client };

  // 2. After sign-in the app silently ensures "Thuis" (idempotent) and loads it.
  const created = await anna.households.createHousehold('Thuis');
  expect(created).toMatchObject({ ok: true, created: true, household: { name: 'Thuis' } });
  const again = await anna.households.createHousehold('Thuis');
  expect(again).toMatchObject({ ok: true, created: false });
  if (!created.ok) throw new Error('unreachable');
  const hh = created.household.id;
  const mine = await anna.households.getMyHousehold();
  expect(mine).toMatchObject({ ok: true, role: 'owner', household: { id: hh, name: 'Thuis' } });
  if (!mine.ok) throw new Error('unreachable');
  expect(mine.members.map((m) => m.display_name)).toEqual([anna.email.split('@')[0]]);

  const annaDevice = await track(openDevice(annaUser, hh));
  await annaDevice.engine.addItem({ name: 'Melk', quantity: 2, unit: 'stuk' });
  await annaDevice.engine.addItem({ name: 'Gehakt', quantity: 500, unit: 'g' });
  await settle([annaDevice]);

  // 3. Invite: "Deel lijst" gives a code and link; asking again reuses the same code.
  const invite = await anna.households.createInvite(hh);
  expect(invite).toMatchObject({ ok: true, url: expect.stringMatching(/^https:\/\/getkar\.nl\/j\/[A-Z0-9]{6}$/) });
  if (!invite.ok) throw new Error('unreachable');
  expect(await anna.households.createInvite(hh)).toMatchObject({ ok: true, code: invite.code });

  // 4. Bram signs up, gets his own silent "Thuis" and puts something on it before joining.
  const bram = await signUpWithMailedCode('journey-bram');
  const bramUser: TestUser = { id: bram.user.id, email: bram.email, client: bram.client };
  const solo = await bram.households.createHousehold('Thuis');
  if (!solo.ok) throw new Error(solo.error);
  const soloDevice = await track(openDevice(bramUser, solo.household.id));
  await soloDevice.engine.addItem({ name: 'melk', quantity: 1, unit: 'stuk' });
  await soloDevice.engine.addItem({ name: 'Bier', quantity: 6, unit: 'stuk' });
  await settle([soloDevice]);

  // Bram listens on his private topic, like the app does, to see the membership broadcasts.
  const bramBroadcasts: { household_id: string; reason: string }[] = [];
  // (A second signed-in client of Bram: the engine's own channel on user:<id> is removed with it.)
  const listener = newClient();
  const { data: bramSession } = await bram.client.auth.getSession();
  await listener.auth.setSession({ access_token: bramSession.session!.access_token, refresh_token: bramSession.session!.refresh_token });
  const bramTopic: RealtimeChannel = listener
    .channel(`user:${bram.user.id}`, { config: { private: true } })
    .on('broadcast', { event: 'membership_changed' }, (m) => bramBroadcasts.push(m.payload as { household_id: string; reason: string }))
    .subscribe();
  await sleep(1_000);

  // "Word je lid van Thuis?" preview, typed lower-case with spaces like a person would.
  const preview = await bram.households.previewInvite(` ${invite.code.toLowerCase()} `);
  expect(preview).toMatchObject({
    ok: true,
    household_id: hh,
    household_name: 'Thuis',
    // Anna signed up with an e-mail code only: her name is the address's local part, which is never
    // shown to someone holding just the code (round 3).
    inviter_name: '',
    member_count: 1,
    leaves_current_household: false,
  });

  // Accept: the app drains the outbox first, then wipes the solo list locally and opens the shared one.
  await soloDevice.engine.syncNow();
  expect(soloDevice.engine.getStatus().pendingCount).toBe(0);
  const accepted = await bram.households.acceptInvite(invite.code);
  expect(accepted).toMatchObject({ ok: true, household_id: hh, moved_items: 2, deleted_household_id: solo.household.id });
  await wipeDevice(soloDevice);
  expect(fs.existsSync(soloDevice.factory.fileFor(bram.user.id))).toBe(false);
  const bramDevice = await track(openDevice(bramUser, hh));
  await settle([annaDevice, bramDevice]);
  // Bram's open items moved along; "melk" merged into Anna's Melk.
  expect(names(annaDevice)).toEqual(['Bier|6|stuk| ', 'Gehakt|500|g| ', 'Melk|3|stuk| ']);
  expect(bramDevice.view()).toEqual(annaDevice.view());
  await waitFor(() => bramBroadcasts.some((b) => b.reason === 'household_deleted'), 10_000, 'old household broadcast');
  expect(bramBroadcasts.find((b) => b.reason === 'household_deleted')!.household_id).toBe(solo.household.id);
  const members = await anna.households.getMyHousehold();
  expect(members.ok && members.members.map((m) => [m.display_name, m.role]).sort()).toEqual(
    [
      [anna.email.split('@')[0], 'owner'],
      [bram.email.split('@')[0], 'member'],
    ].sort(),
  );

  // 5. Both edit at the same time, realtime carries the changes across.
  const melk = annaDevice.engine.getSnapshot().open.find((i) => i.name === 'Melk')!.id;
  await Promise.all([
    (async () => {
      await annaDevice.engine.addItem({ name: 'Brood', quantity: 1, unit: 'stuk' });
      await annaDevice.engine.incrementQuantity(melk, 1);
      await annaDevice.engine.setChecked(melk, true);
    })(),
    (async () => {
      await bramDevice.engine.addItem({ name: 'Chips', quantity: 2, unit: 'stuk' });
      await bramDevice.engine.updateItem(bramDevice.engine.getSnapshot().open.find((i) => i.name === 'Bier')!.id, { quantity: 12, note: 'speciaalbier' });
    })(),
  ]);
  await waitFor(() => names(annaDevice).some((n) => n.startsWith('Chips')) && names(bramDevice).some((n) => n.startsWith('Brood')), 10_000, 'realtime edits');
  await settle([annaDevice, bramDevice]);
  const truth = await serverRows(hh);
  expect(annaDevice.view()).toEqual(truth);
  expect(bramDevice.view()).toEqual(truth);
  expect(names(annaDevice)).toEqual(['Bier|12|stuk| ', 'Brood|1|stuk| ', 'Chips|2|stuk| ', 'Gehakt|500|g| ', 'Melk|4|stuk|x']);

  // 6. Bram leaves: online only, nothing pending; the app wipes his data and makes a new "Thuis".
  expect(bramDevice.engine.getStatus().pendingCount).toBe(0);
  const left = await bram.households.leaveHousehold(hh);
  expect(left).toMatchObject({ ok: true, household_deleted: false, new_owner_id: null });
  await waitFor(() => bramBroadcasts.some((b) => b.reason === 'left' && b.household_id === hh), 10_000, 'left broadcast');
  await wipeDevice(bramDevice);
  expect(fs.existsSync(bramDevice.factory.fileFor(bram.user.id))).toBe(false);
  const fresh = await bram.households.createHousehold('Thuis');
  expect(fresh).toMatchObject({ ok: true, created: true });
  if (!fresh.ok) throw new Error('unreachable');
  const bramNew = await track(openDevice(bramUser, fresh.household.id));
  await settle([bramNew]);
  expect(bramNew.view()).toEqual([]);

  // Anna keeps the list, alone again; Bram's old rows stay (they were household rows).
  const after = await anna.households.getMyHousehold();
  expect(after.ok && after.members.map((m) => m.user_id)).toEqual([anna.user.id]);
  await settle([annaDevice]);
  expect(annaDevice.view()).toEqual(await serverRows(hh));
  expect((await bram.client.rpc('pull_changes', { p_household_id: hh, p_since_seq: 0 })).data).toEqual({ ok: false, error: 'not_member' });
  const { rows } = await db().query('select count(*)::int as n from public.household_members where household_id = $1', [hh]);
  expect(rows[0].n).toBe(1);

  await listener.removeChannel(bramTopic);
});
