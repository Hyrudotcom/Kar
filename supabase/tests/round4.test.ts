/** Round 4 review fixes on the server: merged_from in get_my_household, replay after a switch. */
import { addItem, apply, closePool, createHousehold, createUserWithHousehold, itemRow, joinViaInvite, mutation, rpc, uuid } from './_helpers';

afterAll(closePool);

const add = (hid: string, name: string, quantity = 1, id = uuid()) => mutation(hid, 'add_item', { id, name, quantity, unit: 'stuk' });

describe('get_my_household merged_from', () => {
  test('a solo household merged by accept_invite is listed (another phone follows it), transitively', async () => {
    const J = await createUserWithHousehold('Jan');
    const T = await createHousehold();
    expect((await rpc(J.uid, 'get_my_household')).merged_from).toEqual([]);
    expect((await joinViaInvite(T.hid, T.owner, J.uid)).deleted_household_id).toBe(J.hid);
    const mine = await rpc(J.uid, 'get_my_household');
    expect(mine.household.id).toBe(T.hid);
    expect(mine.merged_from).toEqual([J.hid]);
    // Other members never see Jan's merges.
    expect((await rpc(T.owner, 'get_my_household')).merged_from).toEqual([]);
  });

  test('leaving a shared household (it stays alive) or being removed is not a merge', async () => {
    const S = await createHousehold(2); // Jan is members[0] of a shared household
    const jan = S.members[0]!;
    const Other = await createHousehold();
    const r = await joinViaInvite(Other.hid, Other.owner, jan);
    expect(r).toMatchObject({ ok: true, left_household_id: S.hid, deleted_household_id: null });
    expect((await rpc(jan, 'get_my_household')).merged_from).toEqual([]);

    const R = await createHousehold(2);
    const piet = R.members[0]!;
    expect((await rpc(R.owner, 'remove_member', { p_household_id: R.hid, p_user_id: piet })).ok).toBe(true);
    expect((await rpc(piet, 'create_household', { p_name: 'Thuis' })).ok).toBe(true);
    expect((await rpc(piet, 'get_my_household')).merged_from).toEqual([]);
  });
});

describe('apply_mutations replay after a household switch keeps the real outcome', () => {
  test('a rejection in the old household stays a rejection', async () => {
    const A = await createUserWithHousehold('Anna');
    const B = await createHousehold();
    const del = mutation(A.hid, 'delete_item', { item_id: uuid() });
    const first = await apply(A.uid, A.hid, [del]);
    expect(first.results[0].status).toBe('rejected');
    await joinViaInvite(B.hid, B.owner, A.uid);
    const again = await apply(A.uid, B.hid, [{ ...del, household_id: B.hid }]);
    expect(again.results).toEqual([{ ...first.results[0], replayed: true }]);
  });

  test('an add merged by accept_invite into another row reports merged with that row (undo takes only its quantity)', async () => {
    const A = await createUserWithHousehold('Anna');
    await addItem(A.uid, A.hid, 'Brood', 1);
    const B = await createHousehold();
    const bramBrood = await addItem(B.owner, B.hid, 'Brood', 1);
    const m = add(A.hid, 'Brood', 2);
    expect((await apply(A.uid, A.hid, [m])).results[0].status).toBe('merged'); // response lost
    await joinViaInvite(B.hid, B.owner, A.uid);
    expect((await itemRow(bramBrood)).quantity).toBe('4.000');
    const again = await apply(A.uid, B.hid, [{ ...m, household_id: B.hid }]);
    expect(again.results).toEqual([{ id: m.id, status: 'merged', item_id: bramBrood, replayed: true }]);
  });

  test('an add moved as its own row keeps applied with its id', async () => {
    const A = await createUserWithHousehold('Anna');
    const B = await createHousehold();
    const m = add(A.hid, 'Kaas', 1);
    expect((await apply(A.uid, A.hid, [m])).results[0].status).toBe('applied');
    await joinViaInvite(B.hid, B.owner, A.uid);
    const again = await apply(A.uid, B.hid, [{ ...m, household_id: B.hid }]);
    expect(again.results).toEqual([{ id: m.id, status: 'applied', item_id: m.payload.id, replayed: true }]);
  });
});
