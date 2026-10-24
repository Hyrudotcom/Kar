/**
 * Child process for the kill test (tests/integration/kill.test.ts). Runs the real engine on a SQLite
 * file, queues GB_COUNT adds while offline, goes online and then stops at GB_MODE:
 *   before_send  - the push is about to leave the device
 *   after_server - the server committed the batch, the response has not been processed locally
 * It prints a marker line and hangs; the parent SIGKILLs it at that exact point.
 */
import { createClient } from '@supabase/supabase-js';

import type { ApplyMutationsRequest } from '@/src/contracts';
import { createSyncEngine } from '@/src/sync/engine';
import { BetterSqliteFactory } from '@/src/sync/node/betterSqlite';
import { SupabaseSyncTransport } from '@/src/sync/transports/supabase';
import { ManualConnectivity } from '@/src/sync/util';

const need = (v: string | undefined, name: string): string => {
  if (!v) throw new Error(`missing ${name}`);
  return v;
};

async function main() {
  const client = createClient(need(process.env.GB_API_URL, 'GB_API_URL'), need(process.env.GB_ANON_KEY, 'GB_ANON_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.setSession({ access_token: need(process.env.GB_ACCESS_TOKEN, 'GB_ACCESS_TOKEN'), refresh_token: need(process.env.GB_REFRESH_TOKEN, 'GB_REFRESH_TOKEN') });
  if (error) throw error;
  const userId = need(process.env.GB_USER_ID, 'GB_USER_ID');
  const householdId = need(process.env.GB_HOUSEHOLD_ID, 'GB_HOUSEHOLD_ID');
  const mode = need(process.env.GB_MODE, 'GB_MODE');
  const inner = SupabaseSyncTransport.fromClient(client, userId);
  const hang = () => new Promise<never>(() => undefined);
  let online = false;
  const transport = {
    async applyMutations(req: ApplyMutationsRequest) {
      if (!online) throw new Error('offline');
      if (mode === 'before_send') {
        console.log(`MARK before_send ${req.mutations.length}`);
        return hang();
      }
      const res = await inner.applyMutations(req);
      console.log(`MARK after_server ${req.mutations.length} ${JSON.stringify(res.ok ? res.results.map((r) => r.status) : res)}`);
      return hang();
    },
    pullChanges: inner.pullChanges.bind(inner),
    subscribe: () => () => undefined,
  };
  const connectivity = new ManualConnectivity(false);
  const db = await new BetterSqliteFactory(need(process.env.GB_DIR, 'GB_DIR')).open(userId);
  const engine = createSyncEngine(
    { db, transport, connectivity, userId, householdId, uuid: () => crypto.randomUUID() },
    { pushDebounceMs: 10, batchSize: Number(process.env.GB_BATCH ?? 100) },
  );
  await engine.start();
  const count = Number(need(process.env.GB_COUNT, 'GB_COUNT'));
  for (let i = 0; i < count; i++) await engine.addItem({ name: `Kill ${i}`, quantity: 1, unit: 'stuk' });
  await engine.incrementQuantity(engine.getSnapshot().open.find((i) => i.name === 'Kill 0')!.id, 4);
  console.log(`MARK queued ${engine.getStatus().pendingCount}`);
  online = true;
  connectivity.set(true);
  void engine.syncNow();
  await hang();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
