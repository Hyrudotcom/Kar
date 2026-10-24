/**
 * Local data lifecycle (docs/architecture.md section 2, design-spec 5.9 / 5.10).
 */
import type { SqlDriverFactory, SyncEngine, Uuid } from '@/src/contracts';

/**
 * Logout / leave / removal: stop the engine, then delete the user's database file (list, outbox,
 * failed mutations, suggestion history and price cache all live in it).
 */
export async function wipeLocalData(opts: { engine: SyncEngine | null; factory: SqlDriverFactory; userId: Uuid }): Promise<void> {
  if (opts.engine) await opts.engine.stop();
  await opts.factory.destroy(opts.userId);
}

/**
 * How many unsent changes a user's local file holds, for "Je hebt N wijzigingen die nog niet verstuurd
 * zijn." before signing in as a different account. Opens and closes the file; 0 if it has no outbox.
 * Do not call while an engine is running on that file.
 */
export async function countUnsentChanges(factory: SqlDriverFactory, userId: Uuid): Promise<number> {
  const db = await factory.open(userId);
  try {
    const t = await db.get<{ n: number }>("select count(*) as n from sqlite_master where type = 'table' and name = 'outbox'");
    if (!t || Number(t.n) === 0) return 0;
    const r = await db.get<{ n: number }>("select count(*) as n from outbox where state = 'pending'");
    return Number(r?.n ?? 0);
  } finally {
    await db.close();
  }
}
