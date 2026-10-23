import { AuthRequiredError, TransientSyncError } from '@/src/contracts';
import { SupabaseSyncTransport, type RealtimeChannelLike, type SupabaseLike } from '../transports/supabase';

type RpcRes = Awaited<ReturnType<SupabaseLike['rpc']>>;

function fakeClient(rpc: (fn: string, args?: Record<string, unknown>) => Promise<RpcRes> | RpcRes, session: unknown = { access_token: 't' }) {
  const channels: { name: string; opts?: unknown; handlers: { type: string; filter: Record<string, unknown>; cb: (p: unknown) => void }[]; statusCb?: (s: string) => void; removed: boolean }[] = [];
  const client: SupabaseLike = {
    rpc: (fn, args) => Promise.resolve(rpc(fn, args)),
    auth: { getSession: async () => ({ data: { session } }) },
    channel(name, opts) {
      const ch = { name, opts, handlers: [] as (typeof channels)[number]['handlers'], removed: false, statusCb: undefined as undefined | ((s: string) => void) };
      channels.push(ch);
      const api: RealtimeChannelLike & { __ch: typeof ch } = {
        __ch: ch,
        on(type, filter, cb) {
          ch.handlers.push({ type, filter, cb });
          return api;
        },
        subscribe(cb) {
          ch.statusCb = cb;
          return api;
        },
      };
      return api;
    },
    removeChannel(c) {
      (c as unknown as { __ch: (typeof channels)[number] }).__ch.removed = true;
      return Promise.resolve('ok');
    },
  };
  return { client, channels };
}

const item = {
  id: 'i1', household_id: 'h1', name: 'Melk', normalized_name: 'melk', quantity: '1.500', unit: 'l', note: null,
  checked: false, checked_at: null, position: '7', exclude_from_comparison: false, created_by: null, created_at: 'x',
  updated_by: null, updated_at: 'x', deleted_at: null, deleted_by: null, server_seq: 7,
};

describe('SupabaseSyncTransport', () => {
  test('apply_mutations passes the batch as `batch` and parses results', async () => {
    const calls: unknown[] = [];
    const { client } = fakeClient((fn, args) => {
      calls.push([fn, args]);
      return { data: { ok: true, server_seq: 3, results: [{ id: 'm1', status: 'merged', item_id: 'i9', server_seq: 3, reason: null }] }, error: null, status: 200 };
    });
    const t = new SupabaseSyncTransport({ client, userId: 'u1' });
    const req = { household_id: 'h1', mutations: [] };
    const res = await t.applyMutations(req);
    expect(calls).toEqual([['apply_mutations', { batch: req }]]);
    expect(res).toEqual({ ok: true, server_seq: 3, results: [{ id: 'm1', status: 'merged', item_id: 'i9', server_seq: 3 }] });
  });

  test('pull_changes maps args and coerces numeric strings; ok:false values pass through', async () => {
    let args: unknown;
    const { client } = fakeClient((_fn, a) => {
      args = a;
      return { data: { ok: true, household: { id: 'h1', name: 'Thuis', created_at: 'x', last_seq: '7' }, items: [item], server_seq: 7, has_more: false, reset_required: false }, error: null, status: 200 };
    });
    const t = new SupabaseSyncTransport({ client, userId: 'u1' });
    const res = await t.pullChanges('h1', 3, 500);
    expect(args).toEqual({ p_household_id: 'h1', p_since_seq: 3, p_limit: 500 });
    expect(res.ok && res.items[0]).toMatchObject({ quantity: 1.5, position: 7, note: '' });
    const { client: c2 } = fakeClient(() => ({ data: { ok: false, error: 'not_member' }, error: null, status: 200 }));
    expect(await new SupabaseSyncTransport({ client: c2, userId: 'u1' }).pullChanges('h1', 0)).toEqual({ ok: false, error: 'not_member' });
  });

  test('error mapping: 401/JWT -> AuthRequired, no session -> AuthRequired, network/5xx/malformed -> Transient', async () => {
    const mk = (r: RpcRes | (() => never), session?: unknown) =>
      new SupabaseSyncTransport({ client: fakeClient(() => (typeof r === 'function' ? r() : r), session === undefined ? { a: 1 } : session).client, userId: 'u', timeoutMs: 50 });
    await expect(mk({ data: null, error: { message: 'JWT expired', code: 'PGRST303' }, status: 401 }).pullChanges('h', 0)).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(mk({ data: null, error: null, status: 200 }, null).pullChanges('h', 0)).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(mk({ data: null, error: { message: 'TypeError: fetch failed' }, status: 0 }).pullChanges('h', 0)).rejects.toBeInstanceOf(TransientSyncError);
    await expect(mk({ data: null, error: { message: 'boom', code: 'XX000' }, status: 500 }).pullChanges('h', 0)).rejects.toBeInstanceOf(TransientSyncError);
    await expect(mk({ data: { ok: true, nope: 1 }, error: null, status: 200 }).applyMutations({ household_id: 'h', mutations: [] })).rejects.toBeInstanceOf(TransientSyncError);
    await expect(mk(() => { throw new Error('socket hang up'); }).pullChanges('h', 0)).rejects.toBeInstanceOf(TransientSyncError);
    const slow = new SupabaseSyncTransport({ client: fakeClient(() => new Promise<RpcRes>(() => undefined)).client, userId: 'u', timeoutMs: 20 });
    await expect(slow.pullChanges('h', 0)).rejects.toThrow(/timeout/);
  });

  test('subscribe: postgres changes on the household + private user channel; every event is a nudge', () => {
    const { client, channels } = fakeClient(() => ({ data: null, error: null }));
    const t = new SupabaseSyncTransport({ client, userId: 'u1' });
    const nudges: string[] = [];
    const unsub = t.subscribe('h1', (s) => nudges.push(s));
    expect(channels).toHaveLength(2);
    const [changes, personal] = channels;
    expect(changes!.handlers.map((h) => [h.filter.table, h.filter.filter])).toEqual([
      ['list_items', 'household_id=eq.h1'],
      ['households', 'id=eq.h1'],
    ]);
    expect(personal).toMatchObject({ name: 'user:u1', opts: { config: { private: true } } });
    changes!.handlers[0]!.cb({ new: { quantity: 999 } });
    changes!.handlers[1]!.cb({});
    personal!.handlers[0]!.cb({});
    // membership_changed for another household (old solo household after accept_invite) is ignored
    personal!.handlers[0]!.cb({ payload: { household_id: 'h-old', reason: 'household_deleted' } });
    personal!.handlers[0]!.cb({ payload: { household_id: 'h1', reason: 'removed' } });
    changes!.statusCb?.('SUBSCRIBED');
    expect(nudges).toEqual(['items', 'household', 'membership', 'membership', 'items']);
    unsub();
    expect(channels.every((c) => c.removed)).toBe(true);
  });

  test('subscribe: a still-registered private user channel (realtime-js topic dedupe) is retried, never thrown', () => {
    jest.useFakeTimers();
    try {
      const { client, channels } = fakeClient(() => ({ data: null, error: null }));
      let failures = 2;
      const realChannel = client.channel.bind(client);
      client.channel = (name, opts) => {
        const ch = realChannel(name, opts);
        if (name.startsWith('user:') && failures > 0) {
          failures--;
          return { ...ch, on: () => ({ ...ch, subscribe: () => { throw new Error('tried to subscribe multiple times'); } }) } as typeof ch;
        }
        return ch;
      };
      const t = new SupabaseSyncTransport({ client, userId: 'u1' });
      const nudges: string[] = [];
      let unsub: () => void = () => undefined;
      expect(() => (unsub = t.subscribe('h1', (s) => nudges.push(s)))).not.toThrow();
      jest.advanceTimersByTime(5_000);
      const personal = channels.filter((c) => c.name === 'user:u1');
      expect(personal).toHaveLength(3);
      personal[2]!.handlers[0]!.cb({ payload: { household_id: 'h1', reason: 'removed' } });
      expect(nudges).toEqual(['membership']);
      // Two engines for the same household never share a postgres-changes channel.
      t.subscribe('h1', () => undefined);
      const household = channels.filter((c) => c.name.startsWith('gb-household-h1'));
      expect(new Set(household.map((c) => c.name)).size).toBe(2);
      unsub();
      expect(personal[2]!.removed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
