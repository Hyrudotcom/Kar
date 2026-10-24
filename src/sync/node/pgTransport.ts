/**
 * SyncTransport straight to Postgres (Node only): impersonates a user the way PostgREST does
 * (one transaction per request, `set local role authenticated` + `request.jwt.claims`), so the
 * engine can be tested against the real RPCs and RLS of the local Supabase stack.
 * Realtime is not available over plain pg: subscribe() is a no-op (tests call syncNow()).
 */
import type { Pool } from 'pg';
import {
  TransientSyncError,
  type ApplyMutationsRequest,
  type ApplyMutationsResponse,
  type PullChangesResponse,
  type SyncTransport,
  type Uuid,
} from '@/src/contracts';

export class PgSyncTransport implements SyncTransport {
  online = true;

  constructor(
    private readonly pool: Pool,
    readonly userId: Uuid,
  ) {}

  async call<T>(sql: string, values: unknown[]): Promise<T> {
    if (!this.online) throw new TransientSyncError('offline');
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: this.userId, role: 'authenticated', aud: 'authenticated' }),
      ]);
      await c.query('set local role authenticated');
      const res = await c.query(sql, values);
      await c.query('commit');
      return res.rows[0].r as T;
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw new TransientSyncError(String((e as Error)?.message ?? e));
    } finally {
      c.release();
    }
  }

  applyMutations(req: ApplyMutationsRequest): Promise<ApplyMutationsResponse> {
    return this.call('select public.apply_mutations(batch => $1::jsonb) as r', [JSON.stringify(req)]);
  }

  pullChanges(householdId: Uuid, sinceSeq: number, limit = 500): Promise<PullChangesResponse> {
    return this.call('select public.pull_changes(p_household_id => $1, p_since_seq => $2, p_limit => $3) as r', [
      householdId,
      sinceSeq,
      limit,
    ]);
  }

  subscribe(): () => void {
    return () => undefined;
  }
}
