/** Realtime nudges (docs/architecture.md 3.2): publication and private membership broadcasts. */
import { admin, asUser, closePool, createHousehold, rpc } from './_helpers';

afterAll(closePool);

const broadcasts = (uid: string) =>
  admin<{ event: string; payload: any; private: boolean }>(
    `select event, payload, private from realtime.messages where topic = $1 order by inserted_at`,
    [`user:${uid}`],
  );

test('list_items and households are in the supabase_realtime publication, household_members is not', async () => {
  const rows = await admin(
    `select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by 1`,
  );
  const tables = rows.map((r) => r.tablename);
  expect(tables).toEqual(expect.arrayContaining(['households', 'list_items']));
  expect(tables).not.toContain('household_members');
});

test('the publication sends no deletes (Realtime does not RLS-filter DELETE events)', async () => {
  const [p] = await admin(`select pubinsert, pubupdate, pubdelete, pubtruncate from pg_publication where pubname = 'supabase_realtime'`);
  expect(p).toEqual({ pubinsert: true, pubupdate: true, pubdelete: false, pubtruncate: false });
});

test('remove_member sends a private membership_changed broadcast to the removed user', async () => {
  const H = await createHousehold(2);
  const victim = H.members[0]!;
  await rpc(H.owner, 'remove_member', { p_household_id: H.hid, p_user_id: victim });
  const msgs = await broadcasts(victim);
  expect(msgs).toEqual([
    { event: 'membership_changed', private: true, payload: expect.objectContaining({ household_id: H.hid, reason: 'removed' }) },
  ]);
  expect(await broadcasts(H.owner)).toEqual([]);
});

test('leave, household deletion via accept, and account deletion carry a reason', async () => {
  const H = await createHousehold(2);
  await rpc(H.members[0]!, 'leave_household', { p_household_id: H.hid });
  expect((await broadcasts(H.members[0]!)).map((m) => m.payload.reason)).toEqual(['left']);

  const solo = await createHousehold();
  const inv = await rpc(H.owner, 'create_invite', { p_household_id: H.hid });
  await rpc(solo.owner, 'accept_invite', { p_code: inv.code });
  expect((await broadcasts(solo.owner)).map((m) => [m.payload.household_id, m.payload.reason])).toEqual([
    [solo.hid, 'household_deleted'],
  ]);
});

test('only the user itself may read its private topic', async () => {
  const H = await createHousehold(3);
  const [victim, other] = H.members as [string, string];
  await rpc(H.owner, 'remove_member', { p_household_id: H.hid, p_user_id: victim });
  const read = (uid: string, topic: string) =>
    asUser(uid, async (c) => {
      await c.query(`select set_config('realtime.topic', $1, true)`, [topic]);
      return (await c.query(`select event from realtime.messages where topic = $1`, [topic])).rowCount;
    });
  expect(await read(victim, `user:${victim}`)).toBe(1);
  expect(await read(other, `user:${victim}`)).toBe(0);
  // even when the attacker claims the victim's topic, the policy compares with its own uid
  expect(await read(other, `user:${other}`)).toBe(0);
});
