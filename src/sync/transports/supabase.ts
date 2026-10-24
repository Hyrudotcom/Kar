/**
 * SyncTransport over Supabase (RPC + Realtime). The client is created once by mobile
 * (src/lib/supabase.ts) and injected here.
 *
 * Error mapping:
 *  - no session, HTTP 401, or a JWT error code      -> AuthRequiredError (outbox kept, needsReauth)
 *  - network failure, timeout, 5xx, any other error  -> TransientSyncError (retried with backoff)
 *  - malformed JSON body                             -> TransientSyncError
 *  - `{ ok:false, error }` values are returned as-is (not_member etc. are handled by the engine).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  AuthRequiredError,
  TransientSyncError,
  UNITS,
  type ApplyMutationsRequest,
  type ApplyMutationsResponse,
  type MembershipChangedBroadcast,
  type PullChangesResponse,
  type SyncTransport,
  type Uuid,
} from '@/src/contracts';

/** The subset of SupabaseClient this transport uses (keeps tests free of supabase-js internals). */
export interface SupabaseLike {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message: string; code?: string; details?: string | null } | null;
    status?: number;
  }>;
  channel(name: string, opts?: { config?: { private?: boolean } }): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): Promise<unknown> | unknown;
  auth: { getSession(): Promise<{ data: { session: unknown | null }; error?: { message: string } | null }> };
}

export interface RealtimeChannelLike {
  on(type: string, filter: Record<string, unknown>, callback: (payload: unknown) => void): RealtimeChannelLike;
  subscribe(callback?: (status: string, err?: Error) => void): RealtimeChannelLike;
}

export interface SupabaseTransportOptions {
  client: SupabaseLike;
  /** The signed-in user (private broadcast channel `user:<uid>` for membership changes). */
  userId: Uuid;
  /** Per-request timeout (ms). Default 15 000. */
  timeoutMs?: number;
}

const num = z.coerce.number();
const itemSchema = z.object({
  id: z.string(),
  household_id: z.string(),
  name: z.string(),
  normalized_name: z.string(),
  quantity: num,
  unit: z.enum(UNITS),
  note: z.string().nullable().transform((v) => v ?? ''),
  checked: z.boolean(),
  checked_at: z.string().nullable(),
  position: num,
  exclude_from_comparison: z.boolean(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_by: z.string().nullable(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
  deleted_by: z.string().nullable(),
  server_seq: num,
});
const householdSchema = z.object({ id: z.string(), name: z.string(), created_at: z.string(), last_seq: num });

const pullSchema = z.union([
  z.object({
    ok: z.literal(true),
    household: householdSchema,
    items: z.array(itemSchema),
    server_seq: num,
    has_more: z.boolean(),
    reset_required: z.boolean(),
  }),
  z.object({ ok: z.literal(false), error: z.enum(['not_member', 'not_authenticated']) }),
]);

const resultSchema = z.object({
  id: z.string(),
  status: z.enum(['applied', 'merged', 'restored', 'rejected', 'retry']),
  reason: z.enum(['deleted', 'not_found', 'invalid', 'forbidden']).optional().nullable().transform((v) => v ?? undefined),
  item_id: z.string().optional().nullable().transform((v) => v ?? undefined),
  affected_ids: z.array(z.string()).optional().nullable().transform((v) => v ?? undefined),
  server_seq: num.optional().nullable().transform((v) => (v === null ? undefined : v)),
  replayed: z.boolean().optional().nullable().transform((v) => v ?? undefined),
});
const applySchema = z.union([
  z.object({ ok: z.literal(true), results: z.array(resultSchema), server_seq: num }),
  z.object({ ok: z.literal(false), error: z.enum(['not_member', 'invalid_batch', 'not_authenticated']) }),
]);

const AUTH_CODES = new Set(['PGRST301', 'PGRST302', 'PGRST303', '42501-jwt']);

function isAuthError(status: number | undefined, error: { message: string; code?: string } | null): boolean {
  if (status === 401) return true;
  if (!error) return false;
  if (error.code && AUTH_CODES.has(error.code)) return true;
  return /jwt (expired|malformed)|invalid jwt|not authenticated/i.test(error.message ?? '');
}

let channelSeq = 0;

export class SupabaseSyncTransport implements SyncTransport {
  private readonly timeoutMs: number;

  constructor(private readonly opts: SupabaseTransportOptions) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Convenience for the app: accepts the real supabase-js client. */
  static fromClient(client: SupabaseClient<any, any, any>, userId: Uuid, timeoutMs?: number): SupabaseSyncTransport {
    return new SupabaseSyncTransport({ client: client as unknown as SupabaseLike, userId, timeoutMs });
  }

  async applyMutations(req: ApplyMutationsRequest): Promise<ApplyMutationsResponse> {
    const data = await this.call('apply_mutations', { batch: req });
    const parsed = applySchema.safeParse(data);
    if (!parsed.success) throw new TransientSyncError(`apply_mutations: malformed response (${parsed.error.message})`);
    return parsed.data as ApplyMutationsResponse;
  }

  async pullChanges(householdId: Uuid, sinceSeq: number, limit?: number): Promise<PullChangesResponse> {
    const data = await this.call('pull_changes', {
      p_household_id: householdId,
      p_since_seq: sinceSeq,
      ...(limit !== undefined ? { p_limit: limit } : {}),
    });
    const parsed = pullSchema.safeParse(data);
    if (!parsed.success) throw new TransientSyncError(`pull_changes: malformed response (${parsed.error.message})`);
    return parsed.data as PullChangesResponse;
  }

  subscribe(householdId: Uuid, onNudge: (source: 'items' | 'household' | 'membership') => void): () => void {
    const { client, userId } = this.opts;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // realtime-js returns the EXISTING channel for a topic that is still in its list, and a removed
    // channel only leaves that list after the server acknowledged the leave. An engine restarted right
    // after another one was disposed would get the old, already-subscribed channel (subscribe() throws).
    // So the postgres-changes channel gets a unique topic, and the private user topic (its name is fixed
    // by the realtime.messages policy) is retried until the old one is gone.
    const changes = client
      .channel(`gb-household-${householdId}-${(++channelSeq).toString(36)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'list_items', filter: `household_id=eq.${householdId}` }, () =>
        onNudge('items'),
      )
      .on('postgres_changes', { event: '*', schema: 'public', table: 'households', filter: `id=eq.${householdId}` }, () =>
        onNudge('household'),
      )
      // No household_members changes: DELETE events are not RLS-filtered, so that table is not
      // published. Membership loss arrives on the private user topic below.
      // (Re)subscribed after a dropped socket: events may have been missed, so catch up.
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') onNudge('items');
      });
    let personal: RealtimeChannelLike | null = null;
    const subscribePersonal = (attempt: number) => {
      retry = undefined;
      if (closed) return;
      try {
        personal = client
          .channel(`user:${userId}`, { config: { private: true } })
          .on('broadcast', { event: 'membership_changed' }, (msg: unknown) => {
            // Broadcasts about another household (e.g. the old solo household after accept_invite) are ignored.
            const target = (msg as { payload?: Partial<MembershipChangedBroadcast> } | null)?.payload?.household_id;
            if (target === undefined || target === householdId) onNudge('membership');
          })
          .subscribe();
      } catch {
        personal = null;
        // Membership loss is still detected by every push/pull (not_member); keep trying the nudge.
        if (attempt < 20) retry = setTimeout(() => subscribePersonal(attempt + 1), Math.min(250 * (attempt + 1), 2_000));
      }
    };
    subscribePersonal(0);
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      void client.removeChannel(changes);
      if (personal) void client.removeChannel(personal);
    };
  }

  private async call(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const { client } = this.opts;
    let session: unknown = null;
    try {
      const res = await client.auth.getSession();
      // A failed token refresh while offline is not a lost session: retry later.
      if (res.error) throw new TransientSyncError(`session refresh failed: ${res.error.message}`);
      session = res.data.session;
    } catch (e) {
      if (e instanceof TransientSyncError) throw e;
      throw new TransientSyncError(`session lookup failed: ${String((e as Error)?.message ?? e)}`);
    }
    if (!session) throw new AuthRequiredError('no session');

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TransientSyncError(`${fn}: timeout after ${this.timeoutMs} ms`)), this.timeoutMs);
    });
    let res: Awaited<ReturnType<SupabaseLike['rpc']>>;
    try {
      res = await Promise.race([Promise.resolve(client.rpc(fn, args)), timeout]);
    } catch (e) {
      if (e instanceof TransientSyncError || e instanceof AuthRequiredError) throw e;
      throw new TransientSyncError(`${fn}: ${String((e as Error)?.message ?? e)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (isAuthError(res.status, res.error)) throw new AuthRequiredError(res.error?.message ?? 'unauthorized');
    if (res.error) throw new TransientSyncError(`${fn}: ${res.error.message} (${res.error.code ?? res.status ?? '?'})`);
    return res.data;
  }
}
