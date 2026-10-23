/**
 * Strict household separation (docs/architecture.md 3.1 / 8): every table and every RPC,
 * cross-household, anon, removed members, private schema, direct writes.
 */
import {
  addItem,
  admin,
  apply,
  asRollback,
  asUser,
  closePool,
  createHousehold,
  createUser,
  expectDenied,
  itemRow,
  mutation,
  pool,
  rpc,
  uuid,
} from './_helpers';

afterAll(closePool);

const PUBLIC_TABLES = ['profiles', 'households', 'household_members', 'invites', 'list_items'] as const;
const PRIVATE_TABLES = ['mutations', 'item_aliases', 'invite_attempts'] as const;

/** Every RPC with representative args for household B (the victim). */
function rpcCalls(hidB: string, userB: string, codeB: string): [string, Record<string, unknown>][] {
  return [
    ['apply_mutations', { batch: { household_id: hidB, mutations: [mutation(hidB, 'add_item', { id: uuid(), name: 'x', quantity: 1, unit: 'stuk' })] } }],
    ['pull_changes', { p_household_id: hidB, p_since_seq: 0 }],
    ['get_my_household', {}],
    ['create_household', {}],
    ['create_invite', { p_household_id: hidB }],
    ['preview_invite', { p_code: codeB }],
    ['accept_invite', { p_code: codeB }],
    ['leave_household', { p_household_id: hidB }],
    ['remove_member', { p_household_id: hidB, p_user_id: userB }],
    ['rename_household', { p_household_id: hidB, p_name: 'Gekaapt' }],
    ['delete_account', {}],
  ];
}

describe('two households A and B', () => {
  let A: { hid: string; owner: string; members: string[] };
  let B: { hid: string; owner: string; members: string[] };
  let itemB: string;
  let codeB: string;

  beforeAll(async () => {
    A = await createHousehold(2);
    B = await createHousehold(2);
    itemB = await addItem(B.owner, B.hid, 'Geheime melk');
    const inv = await rpc(B.owner, 'create_invite', { p_household_id: B.hid });
    codeB = inv.code;
  });

  test('a member of A sees only A in every public table', async () => {
    await addItem(A.owner, A.hid, 'Brood');
    await asUser(A.owner, async (c) => {
      const hh = await c.query('select id from public.households');
      expect(hh.rows.map((r) => r.id)).toEqual([A.hid]);
      const mm = await c.query('select distinct household_id from public.household_members');
      expect(mm.rows.map((r) => r.household_id)).toEqual([A.hid]);
      const li = await c.query('select distinct household_id from public.list_items');
      expect(li.rows.map((r) => r.household_id)).toEqual([A.hid]);
      const byId = await c.query('select * from public.list_items where id = $1', [itemB]);
      expect(byId.rowCount).toBe(0);
      const prof = await c.query('select user_id from public.profiles order by user_id');
      expect(prof.rows.map((r) => r.user_id).sort()).toEqual([A.owner, ...A.members].sort());
    });
  });

  test('invites are not readable by anyone through the table, not even own household', async () => {
    await expectDenied(asUser(B.owner, (c) => c.query('select * from public.invites')));
    await expectDenied(asUser(A.owner, (c) => c.query('select code from public.invites')));
  });

  test('direct writes are denied on every public table (insert/update/delete)', async () => {
    const attempts: string[] = [
      `insert into public.households (name) values ('x')`,
      `update public.households set name = 'x' where id = '${A.hid}'`,
      `delete from public.households where id = '${A.hid}'`,
      `insert into public.household_members (household_id, user_id, role) values ('${B.hid}', '${A.owner}', 'member')`,
      `update public.household_members set role = 'owner' where household_id = '${A.hid}'`,
      `delete from public.household_members where household_id = '${A.hid}'`,
      `insert into public.invites (household_id, code) values ('${A.hid}', 'ABCDEF')`,
      `update public.invites set revoked_at = now()`,
      `delete from public.invites`,
      `insert into public.list_items (id, household_id, name, position, server_seq) values ('${uuid()}', '${A.hid}', 'x', 1, 1)`,
      `update public.list_items set name = 'x' where household_id = '${A.hid}'`,
      `delete from public.list_items where household_id = '${A.hid}'`,
      `insert into public.profiles (user_id) values ('${uuid()}')`,
      `delete from public.profiles where user_id = '${A.owner}'`,
      `update public.profiles set created_at = now() where user_id = '${A.owner}'`,
    ];
    for (const sql of attempts) {
      await expectDenied(asRollback(A.owner, (c) => c.query(sql)));
    }
  });

  test('profiles: own row updatable (allowed columns), other rows never', async () => {
    await asUser(A.owner, (c) => c.query(`update public.profiles set display_name = 'Jan' where user_id = $1`, [A.owner]));
    expect((await admin(`select display_name from public.profiles where user_id = $1`, [A.owner]))[0].display_name).toBe('Jan');
    // Co-member and other household: 0 rows affected, not visible for update.
    for (const other of [A.members[0], B.owner]) {
      const r = await asUser(A.owner, (c) =>
        c.query(`update public.profiles set display_name = 'Hack' where user_id = $1`, [other]),
      );
      expect(r.rowCount).toBe(0);
    }
    expect((await admin(`select display_name from public.profiles where user_id = $1`, [B.owner]))[0].display_name).not.toBe('Hack');
    await expect(
      asRollback(A.owner, (c) => c.query(`update public.profiles set display_name = $2 where user_id = $1`, [A.owner, 'x'.repeat(61)])),
    ).rejects.toMatchObject({ code: '23514' });
  });

  test('private schema tables are not accessible to authenticated users', async () => {
    for (const t of PRIVATE_TABLES) {
      await expectDenied(asRollback(A.owner, (c) => c.query(`select * from private.${t}`)));
      await expectDenied(asRollback(A.owner, (c) => c.query(`delete from private.${t}`)));
    }
    await expectDenied(asRollback(A.owner, (c) => c.query(`select private.purge()`)));
    await expectDenied(asRollback(A.owner, (c) => c.query(`select private.new_invite_code()`)));
  });

  test('apply_mutations into B by a member of A: not_member, nothing changes', async () => {
    const before = await itemRow(itemB);
    const r = await apply(A.owner, B.hid, [
      mutation(B.hid, 'update_item', { item_id: itemB, fields: { name: 'Gehackt' } }),
      mutation(B.hid, 'delete_item', { item_id: itemB }),
    ]);
    expect(r).toEqual({ ok: false, error: 'not_member' });
    expect(await itemRow(itemB)).toEqual(before);
  });

  test('mutations in A that target B ids: not_found / forbidden / invalid, no leak, no change', async () => {
    const before = await itemRow(itemB);
    const r = await apply(A.owner, A.hid, [
      mutation(A.hid, 'update_item', { item_id: itemB, fields: { name: 'Gehackt' } }),
      mutation(A.hid, 'increment_quantity', { item_id: itemB, delta: 5 }),
      mutation(A.hid, 'set_checked', { item_id: itemB, checked: true }),
      mutation(A.hid, 'delete_item', { item_id: itemB }),
      mutation(A.hid, 'restore_item', { item_id: itemB }),
      mutation(A.hid, 'clear_checked', { item_ids: [itemB] }),
      // household_id of the mutation points at B while the batch is A's
      mutation(B.hid, 'delete_item', { item_id: itemB }),
      // add_item reusing B's item id
      mutation(A.hid, 'add_item', { id: itemB, name: 'Melk', quantity: 1, unit: 'stuk' }),
    ]);
    expect(r.ok).toBe(true);
    expect(r.results.map((x: any) => [x.status, x.reason ?? null])).toEqual([
      ['rejected', 'not_found'],
      ['rejected', 'not_found'],
      ['rejected', 'not_found'],
      ['rejected', 'not_found'],
      ['rejected', 'not_found'],
      ['applied', null],
      ['rejected', 'forbidden'],
      ['rejected', 'invalid'],
    ]);
    expect(r.results[5].affected_ids).toEqual([]);
    expect(await itemRow(itemB)).toEqual(before);
  });

  test('alias ids of B cannot be used from A', async () => {
    // B merges an add into the existing item -> alias in B
    const aliasId = uuid();
    const m = await apply(B.owner, B.hid, [mutation(B.hid, 'add_item', { id: aliasId, name: 'geheime MELK', quantity: 1, unit: 'stuk' })]);
    expect(m.results[0].status).toBe('merged');
    const before = await itemRow(itemB);
    const r = await apply(A.owner, A.hid, [
      mutation(A.hid, 'delete_item', { item_id: aliasId }),
      mutation(A.hid, 'add_item', { id: aliasId, name: 'Melk', quantity: 1, unit: 'stuk' }),
    ]);
    expect(r.results.map((x: any) => x.reason)).toEqual(['not_found', 'invalid']);
    expect(await itemRow(itemB)).toEqual(before);
  });

  test("replaying B's mutation id as a member of A returns invalid and leaks nothing", async () => {
    const mid = uuid();
    await apply(B.owner, B.hid, [mutation(B.hid, 'add_item', { id: uuid(), name: 'Kaas', quantity: 1, unit: 'stuk' }, mid)]);
    const r = await apply(A.owner, A.hid, [mutation(A.hid, 'add_item', { id: uuid(), name: 'Kaas', quantity: 1, unit: 'stuk' }, mid)]);
    expect(r.results[0]).toEqual({ id: mid, status: 'rejected', reason: 'invalid' });
  });

  test('pull_changes of B by a member of A: not_member', async () => {
    expect(await rpc(A.owner, 'pull_changes', { p_household_id: B.hid, p_since_seq: 0 })).toEqual({ ok: false, error: 'not_member' });
    expect(await rpc(A.owner, 'pull_changes', { p_household_id: uuid(), p_since_seq: 0 })).toEqual({ ok: false, error: 'not_member' });
  });

  test('household RPCs on B by a member of A are refused', async () => {
    expect(await rpc(A.owner, 'create_invite', { p_household_id: B.hid })).toEqual({ ok: false, error: 'not_member' });
    expect(await rpc(A.owner, 'create_invite', { p_household_id: B.hid, p_replace: true })).toEqual({ ok: false, error: 'not_member' });
    expect(await rpc(A.owner, 'leave_household', { p_household_id: B.hid })).toEqual({ ok: false, error: 'not_member' });
    expect(await rpc(A.owner, 'remove_member', { p_household_id: B.hid, p_user_id: B.members[0] })).toEqual({ ok: false, error: 'not_member' });
    expect(await rpc(A.owner, 'rename_household', { p_household_id: B.hid, p_name: 'Gekaapt' })).toEqual({ ok: false, error: 'not_member' });
    // the owner of A cannot remove someone of B via A either
    expect(await rpc(A.owner, 'remove_member', { p_household_id: A.hid, p_user_id: B.members[0] })).toEqual({ ok: false, error: 'not_member' });
    const members = await admin(`select user_id from public.household_members where household_id = $1`, [B.hid]);
    expect(members).toHaveLength(2);
    expect((await admin(`select name from public.households where id = $1`, [B.hid]))[0].name).toBe('Thuis');
  });

  test('get_my_household only returns the own household', async () => {
    const r = await rpc(A.members[0]!, 'get_my_household');
    expect(r.household.id).toBe(A.hid);
    expect(r.members.map((m: any) => m.user_id).sort()).toEqual([A.owner, ...A.members].sort());
  });

  test('anon: no table, no RPC', async () => {
    for (const t of PUBLIC_TABLES) {
      await expectDenied(asRollback(null, (c) => c.query(`select * from public.${t}`)));
    }
    for (const t of PRIVATE_TABLES) {
      await expectDenied(asRollback(null, (c) => c.query(`select * from private.${t}`)));
    }
    for (const [name, args] of rpcCalls(B.hid, B.members[0]!, codeB)) {
      await expectDenied(rpc(null, name, args));
    }
    await expectDenied(asRollback(null, (c) => c.query(`select public.gb_normalize_name('x')`)));
    await expectDenied(asRollback(null, (c) => c.query(`select private.is_member($1)`, [B.hid])));
  });

  test('authenticated without jwt sub (no user) gets not_authenticated values', async () => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claims', '{"role":"authenticated"}', true)`);
      await c.query('set local role authenticated');
      for (const [name, args] of rpcCalls(B.hid, B.members[0]!, codeB)) {
        const keys = Object.keys(args);
        const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
        const res = await c.query(sql, keys.map((k) => (typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])));
        expect([name, res.rows[0].r]).toEqual([name, { ok: false, error: 'not_authenticated' }]);
      }
      const rows = await c.query('select * from public.list_items');
      expect(rows.rowCount).toBe(0);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  test('every public table has RLS enabled and anon has no privileges anywhere in our schema', async () => {
    const rls = await admin(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p')`,
    );
    for (const r of rls) expect([r.relname, r.relrowsecurity]).toEqual([r.relname, true]);
    const anonTables = await admin(
      `select table_schema, table_name, privilege_type from information_schema.role_table_grants
        where grantee in ('anon', 'PUBLIC') and table_schema in ('public', 'private')
          and table_name = any($1)`,
      [[...PUBLIC_TABLES, ...PRIVATE_TABLES]],
    );
    expect(anonTables).toEqual([]);
    const anonFns = await admin(
      `select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')`,
    );
    expect(anonFns).toEqual([]);
  });

  test('every security definer function pins search_path', async () => {
    const fns = await admin(
      `select p.oid::regprocedure::text as fn, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.prosecdef`,
    );
    expect(fns.length).toBeGreaterThan(10);
    for (const f of fns) expect([f.fn, f.proconfig]).toEqual([f.fn, ['search_path=""']]);
  });
});

describe('removed member', () => {
  test('loses read and write access immediately, also with an old invite code', async () => {
    const H = await createHousehold(2);
    const victim = H.members[0]!;
    const item = await addItem(H.owner, H.hid, 'Appels');
    const inv = await rpc(H.owner, 'create_invite', { p_household_id: H.hid });

    // still a member: can see it
    await asUser(victim, async (c) => {
      expect((await c.query('select id from public.list_items')).rowCount).toBe(1);
    });

    const rm = await rpc(H.owner, 'remove_member', { p_household_id: H.hid, p_user_id: victim });
    expect(rm).toEqual({ ok: true, invite_revoked: true });

    await asUser(victim, async (c) => {
      for (const t of ['households', 'household_members', 'list_items']) {
        expect([t, (await c.query(`select * from public.${t}`)).rowCount]).toEqual([t, 0]);
      }
      const prof = await c.query('select user_id from public.profiles');
      expect(prof.rows.map((r) => r.user_id)).toEqual([victim]);
    });
    expect(await apply(victim, H.hid, [mutation(H.hid, 'delete_item', { item_id: item })])).toEqual({ ok: false, error: 'not_member' });
    expect(await rpc(victim, 'pull_changes', { p_household_id: H.hid, p_since_seq: 0 })).toEqual({ ok: false, error: 'not_member' });
    expect(await rpc(victim, 'create_invite', { p_household_id: H.hid })).toEqual({ ok: false, error: 'not_member' });
    expect(await rpc(victim, 'get_my_household')).toEqual({ ok: true, household: null, role: null, members: [] });
    // the old code no longer works for the removed member (or anyone)
    expect(await rpc(victim, 'accept_invite', { p_code: inv.code })).toEqual({ ok: false, error: 'expired_code' });
    expect(await rpc(victim, 'preview_invite', { p_code: inv.code })).toEqual({ ok: false, error: 'expired_code' });
    expect((await itemRow(item)).deleted_at).toBeNull();
    // the next "Deel lijst" gets a fresh code
    const inv2 = await rpc(H.owner, 'create_invite', { p_household_id: H.hid });
    expect(inv2.ok).toBe(true);
    expect(inv2.code).not.toBe(inv.code);
  });

  test('a member removed between two batches gets not_member on the next batch', async () => {
    const H = await createHousehold(2);
    const m = H.members[0]!;
    const ok = await apply(m, H.hid, [mutation(H.hid, 'add_item', { id: uuid(), name: 'Thee', quantity: 1, unit: 'stuk' })]);
    expect(ok.ok).toBe(true);
    await rpc(H.owner, 'remove_member', { p_household_id: H.hid, p_user_id: m });
    const r = await apply(m, H.hid, [mutation(H.hid, 'add_item', { id: uuid(), name: 'Koffie', quantity: 1, unit: 'stuk' })]);
    expect(r).toEqual({ ok: false, error: 'not_member' });
    const names = await admin(`select name from public.list_items where household_id = $1`, [H.hid]);
    expect(names.map((x) => x.name)).toEqual(['Thee']);
  });

  test('a user without household sees nothing', async () => {
    const u = await createUser();
    await asUser(u, async (c) => {
      for (const t of ['households', 'household_members', 'list_items']) {
        expect((await c.query(`select * from public.${t}`)).rowCount).toBe(0);
      }
    });
  });
});
