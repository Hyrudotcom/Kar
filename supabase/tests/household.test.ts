/** Household and invite RPCs (docs/architecture.md 4.3). */
import { INVITE_CODE_REGEX } from '@/src/contracts';
import {
  addItem,
  addMemberDirect,
  admin,
  apply,
  asUser,
  closePool,
  createHousehold,
  createUser,
  createUserWithHousehold,
  itemRow,
  joinViaInvite,
  mutation,
  rpc,
  uuid,
} from './_helpers';

afterAll(closePool);
beforeAll(() => admin(`delete from private.invite_attempts`));

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = () => Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join('');

const members = (hid: string) =>
  admin<{ user_id: string; role: string }>(
    `select user_id, role from public.household_members where household_id = $1 order by joined_at, user_id`,
    [hid],
  );

describe('create_household / get_my_household', () => {
  test('ensure is idempotent, also when called concurrently', async () => {
    const u = await createUser('Jan');
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => rpc(u, 'create_household', {})));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(new Set(rs.map((r) => r.household.id)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(rs[0].household).toEqual({ id: expect.any(String), name: 'Thuis', created_at: expect.any(String), last_seq: 0 });
    const again = await rpc(u, 'create_household', { p_name: 'Anders' });
    expect(again).toMatchObject({ ok: true, created: false, household: { name: 'Thuis' } });

    const me = await rpc(u, 'get_my_household');
    expect(me).toEqual({
      ok: true,
      household: rs[0].household,
      role: 'owner',
      members: [{ household_id: rs[0].household.id, user_id: u, role: 'owner', joined_at: expect.any(String), display_name: 'Jan' }],
    });
  });

  test('name validation', async () => {
    const u = await createUser();
    expect(await rpc(u, 'create_household', { p_name: '   ' })).toEqual({ ok: false, error: 'invalid' });
    expect(await rpc(u, 'create_household', { p_name: 'x'.repeat(61) })).toEqual({ ok: false, error: 'invalid' });
    expect(await rpc(u, 'create_household', { p_name: ' Studentenhuis ' })).toMatchObject({ ok: true, household: { name: 'Studentenhuis' } });
  });

  test('display_name comes from auth metadata, then e-mail', async () => {
    const id = uuid();
    await admin(
      `insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data) values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}')`,
      [id, `sanne.de.vries+${id}@example.test`],
    );
    expect((await admin(`select display_name from public.profiles where user_id = $1`, [id]))[0].display_name).toBe(`sanne.de.vries+${id}`);
  });
});

describe('create_invite', () => {
  test('one active code per household: reused while valid, any member may share', async () => {
    const H = await createHousehold(2);
    const a = await rpc(H.owner, 'create_invite', { p_household_id: H.hid });
    expect(a).toEqual({ ok: true, code: expect.stringMatching(INVITE_CODE_REGEX), expires_at: expect.any(String), url: `https://goedboodschap.nl/j/${a.code}` });
    const days = (Date.parse(a.expires_at) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7.0001);
    const b = await rpc(H.members[0]!, 'create_invite', { p_household_id: H.hid });
    expect(b.code).toBe(a.code);
  });

  test('replace is owner only and revokes the old code', async () => {
    const H = await createHousehold(2);
    const a = await rpc(H.owner, 'create_invite', { p_household_id: H.hid });
    expect(await rpc(H.members[0]!, 'create_invite', { p_household_id: H.hid, p_replace: true })).toEqual({ ok: false, error: 'not_owner' });
    const b = await rpc(H.owner, 'create_invite', { p_household_id: H.hid, p_replace: true });
    expect(b.code).not.toBe(a.code);
    const joiner = await createUser();
    expect(await rpc(joiner, 'preview_invite', { p_code: a.code })).toEqual({ ok: false, error: 'expired_code' });
    expect((await rpc(joiner, 'preview_invite', { p_code: b.code })).ok).toBe(true);
  });

  test('expired code is replaced by a new one on the next share', async () => {
    const H = await createHousehold();
    const a = await rpc(H.owner, 'create_invite', { p_household_id: H.hid });
    await admin(`update public.invites set expires_at = now() - interval '1 second' where code = $1`, [a.code]);
    const joiner = await createUser();
    expect(await rpc(joiner, 'accept_invite', { p_code: a.code })).toEqual({ ok: false, error: 'expired_code' });
    const b = await rpc(H.owner, 'create_invite', { p_household_id: H.hid });
    expect(b.code).not.toBe(a.code);
    const rows = await admin(`select code, revoked_at is not null as revoked from public.invites where household_id = $1 order by created_at`, [H.hid]);
    expect(rows).toEqual([{ code: a.code, revoked: true }, { code: b.code, revoked: false }]);
  });

  test('codes are random, well-formed and unique', async () => {
    const codes = await admin<{ c: string }>(`select private.new_invite_code() as c from generate_series(1, 2000)`);
    for (const { c } of codes) expect(c).toMatch(INVITE_CODE_REGEX);
    expect(new Set(codes.map((x) => x.c)).size).toBeGreaterThan(1995);
    const letters = new Set(codes.flatMap((x) => [...x.c]));
    expect(letters.size).toBe(32);
  });
});

describe('preview_invite / accept_invite', () => {
  test('preview shows household, inviter, member count; input is trimmed and upper-cased', async () => {
    const H = await createHousehold(2);
    await admin(`update public.profiles set display_name = 'Sanne' where user_id = $1`, [H.owner]);
    const inv = await rpc(H.owner, 'create_invite', { p_household_id: H.hid });
    const j = await createUserWithHousehold();
    const p = await rpc(j.uid, 'preview_invite', { p_code: `  ${inv.code.toLowerCase()} ` });
    expect(p).toEqual({
      ok: true, household_id: H.hid, household_name: 'Thuis', inviter_name: 'Sanne', member_count: 2,
      leaves_current_household: false, current_household_name: 'Thuis',
    });
    // preview has no side effects on membership
    expect(await members(j.hid)).toHaveLength(1);
  });

  test('error codes: invalid_code, expired_code, already_member', async () => {
    const H = await createHousehold();
    const inv = await rpc(H.owner, 'create_invite', { p_household_id: H.hid });
    const u = await createUser();
    await admin(`delete from private.invite_attempts where code in ('ZZZZZZ', 'ABC', 'O0I1AB', '')`);
    expect(await rpc(u, 'preview_invite', { p_code: 'ZZZZZZ' })).toEqual({ ok: false, error: 'invalid_code' });
    expect(await rpc(u, 'preview_invite', { p_code: 'ABC' })).toEqual({ ok: false, error: 'invalid_code' });
    expect(await rpc(u, 'accept_invite', { p_code: 'O0I1AB' })).toEqual({ ok: false, error: 'invalid_code' });
    expect(await rpc(u, 'accept_invite', { p_code: null })).toEqual({ ok: false, error: 'invalid_code' });
    expect(await rpc(H.owner, 'accept_invite', { p_code: inv.code })).toEqual({ ok: false, error: 'already_member' });
    expect(await rpc(H.owner, 'preview_invite', { p_code: inv.code })).toEqual({ ok: false, error: 'already_member' });
  });

  test('alone in current household: open items move along (deduped), old household deleted', async () => {
    const T = await createHousehold();
    const melkT = await addItem(T.owner, T.hid, 'Melk', 1);
    const J = await createUserWithHousehold('Joiner');
    const melkJ = await addItem(J.uid, J.hid, 'melk', 2);
    const brood = await addItem(J.uid, J.hid, 'Brood', 1);
    const kaas = await addItem(J.uid, J.hid, 'Kaas', 1);
    const checked = await addItem(J.uid, J.hid, 'Afgevinkt', 1);
    const deleted = await addItem(J.uid, J.hid, 'Weg', 1);
    await apply(J.uid, J.hid, [
      mutation(J.hid, 'set_checked', { item_id: checked, checked: true }),
      mutation(J.hid, 'delete_item', { item_id: deleted }),
    ]);
    const inv = await rpc(T.owner, 'create_invite', { p_household_id: T.hid });
    const r = await rpc(J.uid, 'accept_invite', { p_code: inv.code });
    expect(r).toEqual({ ok: true, household_id: T.hid, moved_items: 3, left_household_id: null, deleted_household_id: J.hid });

    expect(await admin(`select id from public.households where id = $1`, [J.hid])).toEqual([]);
    expect(await members(T.hid)).toEqual([{ user_id: T.owner, role: 'owner' }, { user_id: J.uid, role: 'member' }]);
    expect((await itemRow(melkT)).quantity).toBe('3.000');
    expect(await itemRow(melkJ)).toBeNull();
    expect(await itemRow(checked)).toBeNull();
    expect(await itemRow(deleted)).toBeNull();
    const b = await itemRow(brood);
    const k = await itemRow(kaas);
    expect(b.household_id).toBe(T.hid);
    expect(Number(k.position)).toBeGreaterThan(Number(b.position)); // newest stays on top
    expect(Number(b.server_seq)).toBeGreaterThan(1);
    // pending edits on the old melk id are redirected to the target
    const e = await apply(J.uid, T.hid, [mutation(T.hid, 'increment_quantity', { item_id: melkJ, delta: 1 })]);
    expect(e.results[0]).toMatchObject({ status: 'applied', item_id: melkT });
    // everything is visible to the joiner through pull
    const p = await rpc(J.uid, 'pull_changes', { p_household_id: T.hid, p_since_seq: 0 });
    expect(p.items.map((x: any) => x.name).sort()).toEqual(['Brood', 'Kaas', 'Melk']);
  });

  test('household with others: caller leaves (ownership transfers), items stay', async () => {
    const T = await createHousehold();
    const O = await createHousehold(3); // owner + 2 members
    const item = await addItem(O.owner, O.hid, 'Blijft');
    const inv = await rpc(T.owner, 'create_invite', { p_household_id: T.hid });
    const p = await rpc(O.owner, 'preview_invite', { p_code: inv.code });
    expect(p).toMatchObject({ leaves_current_household: true, current_household_name: 'Thuis' });
    const r = await rpc(O.owner, 'accept_invite', { p_code: inv.code });
    expect(r).toEqual({ ok: true, household_id: T.hid, moved_items: 0, left_household_id: O.hid, deleted_household_id: null });
    expect(await members(O.hid)).toEqual([{ user_id: O.members[0], role: 'owner' }, { user_id: O.members[1], role: 'member' }]);
    expect((await itemRow(item)).household_id).toBe(O.hid);
    // and the leaver can no longer read O
    await asUser(O.owner, async (c) => {
      expect((await c.query('select * from public.list_items where household_id = $1', [O.hid])).rowCount).toBe(0);
    });
  });

  test('without any household: just joins', async () => {
    const T = await createHousehold();
    const u = await createUser();
    const r = await joinViaInvite(T.hid, T.owner, u);
    expect(r).toEqual({ ok: true, household_id: T.hid, moved_items: 0, left_household_id: null, deleted_household_id: null });
  });

  test('rate limit per user: 10 attempts per 10 minutes', async () => {
    const u = await createUser();
    for (let i = 0; i < 10; i++) {
      expect((await rpc(u, 'preview_invite', { p_code: randomCode() })).error).toBe('invalid_code');
    }
    expect(await rpc(u, 'preview_invite', { p_code: randomCode() })).toEqual({ ok: false, error: 'rate_limited' });
    const T = await createHousehold();
    const inv = await rpc(T.owner, 'create_invite', { p_household_id: T.hid });
    expect(await rpc(u, 'accept_invite', { p_code: inv.code })).toEqual({ ok: false, error: 'rate_limited' });
    await admin(`update private.invite_attempts set at = now() - interval '11 minutes' where user_id = $1`, [u]);
    expect((await rpc(u, 'accept_invite', { p_code: inv.code })).ok).toBe(true);
  });

  test('rate limit per IP: 30 per hour across users', async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    await admin(`delete from private.invite_attempts where ip = $1`, [ip]);
    for (let i = 0; i < 30; i++) {
      const u = await createUser();
      expect((await rpc(u, 'preview_invite', { p_code: randomCode() }, { ip })).ok).toBe(false);
    }
    const u = await createUser();
    expect(await rpc(u, 'preview_invite', { p_code: randomCode() }, { ip })).toEqual({ ok: false, error: 'rate_limited' });
    await admin(`delete from private.invite_attempts where ip = '203.0.113.9'`);
    expect((await rpc(u, 'preview_invite', { p_code: randomCode() }, { ip: '203.0.113.9' })).error).toBe('invalid_code');
    const logged = await admin(`select ip from private.invite_attempts where user_id = $1 order by id`, [u]);
    expect(logged.map((x) => x.ip)).toEqual([ip, '203.0.113.9']);
  });

  test('rate limit per code: 10 failed per hour', async () => {
    const code = 'HHHHHH';
    await admin(`delete from private.invite_attempts where code = $1`, [code]);
    for (let i = 0; i < 10; i++) {
      const u = await createUser();
      expect((await rpc(u, 'preview_invite', { p_code: code })).error).toBe('invalid_code');
    }
    const u = await createUser();
    expect(await rpc(u, 'preview_invite', { p_code: code })).toEqual({ ok: false, error: 'rate_limited' });
  });

  test('x-forwarded-for is not an IP (the client sets it); only cf-connecting-ip counts', async () => {
    const u = await createUser();
    expect((await rpc(u, 'preview_invite', { p_code: randomCode() }, { headers: { 'x-forwarded-for': '203.0.113.77' } })).error).toBe('invalid_code');
    expect((await rpc(u, 'preview_invite', { p_code: randomCode() }, { headers: { 'cf-connecting-ip': '203.0.113.78', 'x-forwarded-for': '1.2.3.4' } })).error).toBe('invalid_code');
    const logged = await admin(`select ip from private.invite_attempts where user_id = $1 order by id`, [u]);
    expect(logged.map((x) => x.ip)).toEqual([null, '203.0.113.78']);
  });

  test('rate limit per account: 30 failed lookups per day, whatever the IP', async () => {
    const u = await createUser();
    await admin(
      `insert into private.invite_attempts (user_id, ip, code, success, at)
       select $1, '198.51.100.' || g, 'QQQQQ' || g, false, now() - interval '2 hours' from generate_series(1, 30) g`,
      [u],
    );
    expect(await rpc(u, 'preview_invite', { p_code: randomCode() }, { ip: '203.0.113.90' })).toEqual({ ok: false, error: 'rate_limited' });
    await admin(`update private.invite_attempts set at = now() - interval '25 hours' where user_id = $1`, [u]);
    expect((await rpc(u, 'preview_invite', { p_code: randomCode() }, { ip: '203.0.113.90' })).error).toBe('invalid_code');
  });

  test('global ceiling: 200 failed lookups of unknown codes per 10 minutes, across accounts and IPs', async () => {
    try {
      await admin(
        `insert into private.invite_attempts (user_id, ip, code, success)
         select gen_random_uuid(), null, 'GLOBALTEST', false from generate_series(1, 200)`,
      );
      const u = await createUser();
      expect(await rpc(u, 'preview_invite', { p_code: randomCode() })).toEqual({ ok: false, error: 'rate_limited' });
    } finally {
      await admin(`delete from private.invite_attempts where code = 'GLOBALTEST'`);
    }
    const u = await createUser();
    expect((await rpc(u, 'preview_invite', { p_code: randomCode() })).error).toBe('invalid_code');
  });

  test('household block: 20 failed attempts on its expired/revoked codes block joining it for the hour', async () => {
    const T = await createHousehold();
    const old = await rpc(T.owner, 'create_invite', { p_household_id: T.hid });
    const fresh = await rpc(T.owner, 'create_invite', { p_household_id: T.hid, p_replace: true });
    // 20 attempts on the revoked code by different users (the per-code limit allows 10, so spread over two codes)
    const old2 = await rpc(T.owner, 'create_invite', { p_household_id: T.hid, p_replace: true });
    const current = await rpc(T.owner, 'create_invite', { p_household_id: T.hid, p_replace: true });
    for (const code of [old.code, fresh.code]) {
      for (let i = 0; i < 10; i++) {
        const u = await createUser();
        expect((await rpc(u, 'preview_invite', { p_code: code })).error).toBe('expired_code');
      }
    }
    const u = await createUser();
    expect(await rpc(u, 'accept_invite', { p_code: current.code })).toEqual({ ok: false, error: 'rate_limited' });
    expect(await rpc(u, 'preview_invite', { p_code: old2.code })).toEqual({ ok: false, error: 'rate_limited' });
    await admin(`update private.invite_attempts set at = now() - interval '61 minutes' where household_id = $1`, [T.hid]);
    expect((await rpc(u, 'accept_invite', { p_code: current.code })).ok).toBe(true);
  });

  test('concurrent accepts of the same user do not double-join', async () => {
    const T = await createHousehold();
    const J = await createUserWithHousehold();
    await addItem(J.uid, J.hid, 'Eén keer');
    const inv = await rpc(T.owner, 'create_invite', { p_household_id: T.hid });
    const rs = await Promise.allSettled([1, 2, 3].map(() => rpc(J.uid, 'accept_invite', { p_code: inv.code })));
    const oks = rs.filter((r) => r.status === 'fulfilled' && (r.value as any).ok);
    expect(oks).toHaveLength(1);
    for (const r of rs) {
      if (r.status === 'fulfilled' && !(r.value as any).ok) expect((r.value as any).error).toBe('already_member');
    }
    expect(await members(T.hid)).toHaveLength(2);
    const items = await admin(`select name from public.list_items where household_id = $1`, [T.hid]);
    expect(items.map((x) => x.name)).toEqual(['Eén keer']);
  });
});

describe('leave / remove / rename / delete_account', () => {
  test('owner leaves: longest-standing member becomes owner', async () => {
    const H = await createHousehold(3);
    const r = await rpc(H.owner, 'leave_household', { p_household_id: H.hid });
    expect(r).toEqual({ ok: true, household_deleted: false, new_owner_id: H.members[0] });
    expect(await members(H.hid)).toEqual([{ user_id: H.members[0], role: 'owner' }, { user_id: H.members[1], role: 'member' }]);
    expect(await rpc(H.owner, 'leave_household', { p_household_id: H.hid })).toEqual({ ok: false, error: 'not_member' });
    // after leaving: ensure creates a fresh "Thuis"
    const c = await rpc(H.owner, 'create_household', {});
    expect(c).toMatchObject({ ok: true, created: true });
    expect(c.household.id).not.toBe(H.hid);
  });

  test('member leaves: no ownership change', async () => {
    const H = await createHousehold(2);
    expect(await rpc(H.members[0]!, 'leave_household', { p_household_id: H.hid })).toEqual({ ok: true, household_deleted: false, new_owner_id: null });
    expect(await members(H.hid)).toEqual([{ user_id: H.owner, role: 'owner' }]);
  });

  test('last member leaves: household and its list are deleted', async () => {
    const H = await createHousehold();
    const item = await addItem(H.owner, H.hid, 'x');
    await rpc(H.owner, 'create_invite', { p_household_id: H.hid });
    expect(await rpc(H.owner, 'leave_household', { p_household_id: H.hid })).toEqual({ ok: true, household_deleted: true, new_owner_id: null });
    expect(await admin(`select id from public.households where id = $1`, [H.hid])).toEqual([]);
    expect(await itemRow(item)).toBeNull();
    expect(await admin(`select id from public.invites where household_id = $1`, [H.hid])).toEqual([]);
  });

  test('remove_member: owner only, not self, member must exist', async () => {
    const H = await createHousehold(3);
    const [m1, m2] = H.members as [string, string];
    expect(await rpc(m1, 'remove_member', { p_household_id: H.hid, p_user_id: m2 })).toEqual({ ok: false, error: 'not_owner' });
    expect(await rpc(H.owner, 'remove_member', { p_household_id: H.hid, p_user_id: H.owner })).toEqual({ ok: false, error: 'cannot_remove_self' });
    expect(await rpc(H.owner, 'remove_member', { p_household_id: H.hid, p_user_id: uuid() })).toEqual({ ok: false, error: 'not_member' });
    // no active invite: still ok, invite_revoked false
    expect(await rpc(H.owner, 'remove_member', { p_household_id: H.hid, p_user_id: m2 })).toEqual({ ok: true, invite_revoked: false });
    expect(await members(H.hid)).toEqual([{ user_id: H.owner, role: 'owner' }, { user_id: m1, role: 'member' }]);
  });

  test('rename_household: owner only, trimmed, 1..60, arrives with pull', async () => {
    const H = await createHousehold(2);
    expect(await rpc(H.members[0]!, 'rename_household', { p_household_id: H.hid, p_name: 'Hack' })).toEqual({ ok: false, error: 'not_owner' });
    expect(await rpc(H.owner, 'rename_household', { p_household_id: H.hid, p_name: '  ' })).toEqual({ ok: false, error: 'invalid' });
    expect(await rpc(H.owner, 'rename_household', { p_household_id: H.hid, p_name: 'y'.repeat(61) })).toEqual({ ok: false, error: 'invalid' });
    const r = await rpc(H.owner, 'rename_household', { p_household_id: H.hid, p_name: ' De Linde ' });
    expect(r).toMatchObject({ ok: true, household: { id: H.hid, name: 'De Linde' } });
    const p = await rpc(H.members[0]!, 'pull_changes', { p_household_id: H.hid, p_since_seq: 0 });
    expect(p.household.name).toBe('De Linde');
  });

  test('delete_account: owner with members -> transfer, auth user and profile gone, items keep existing', async () => {
    const H = await createHousehold(2);
    const item = await addItem(H.owner, H.hid, 'Blijft staan');
    await apply(H.owner, H.hid, [mutation(H.hid, 'add_item', { id: uuid(), name: 'log', quantity: 1, unit: 'stuk' })]);
    const r = await rpc(H.owner, 'delete_account');
    expect(r).toEqual({ ok: true, household_deleted: false });
    expect(await admin(`select id from auth.users where id = $1`, [H.owner])).toEqual([]);
    expect(await admin(`select user_id from public.profiles where user_id = $1`, [H.owner])).toEqual([]);
    expect(await admin(`select id from private.mutations where user_id = $1`, [H.owner])).toEqual([]);
    expect(await members(H.hid)).toEqual([{ user_id: H.members[0], role: 'owner' }]);
    expect(await itemRow(item)).toMatchObject({ household_id: H.hid, created_by: null });
  });

  test('delete_account: last member -> household deleted; without household -> ok', async () => {
    const H = await createHousehold();
    expect(await rpc(H.owner, 'delete_account')).toEqual({ ok: true, household_deleted: true });
    expect(await admin(`select id from public.households where id = $1`, [H.hid])).toEqual([]);
    const u = await createUser();
    expect(await rpc(u, 'delete_account')).toEqual({ ok: true, household_deleted: false });
  });

  test('one household per user is enforced', async () => {
    const A = await createHousehold();
    const B = await createHousehold();
    await expect(addMemberDirect(B.hid, A.owner)).rejects.toMatchObject({ code: '23505' });
  });
});
