/**
 * The demo backend with the REAL sync engine: per-user better-sqlite3 files and a FakeTransport to
 * the demo world's in-memory server (which follows the demo connectivity).
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Backend } from '@/src/lib/backend/types';
import { countUnsentChanges, createSyncEngine, wipeLocalData } from '@/src/sync';
import { BetterSqliteFactory } from '@/src/sync/node/betterSqlite';
import { FakeTransport } from '@/src/sync/testing';

import { makeBackend } from './helpers';

export function realBackend(opts: { factory?: BetterSqliteFactory } = {}) {
  const factory = opts.factory ?? new BetterSqliteFactory(fs.mkdtempSync(path.join(os.tmpdir(), 'gb-real-')));
  const transports = new Map<string, FakeTransport>();
  const demo = makeBackend();
  const backend: Backend & { world: typeof demo.world; connectivity: typeof demo.connectivity } = {
    ...demo,
    local: {
      async openEngine(user, householdId) {
        const transport = new FakeTransport(demo.world.server, user.id, { online: demo.connectivity.isOnline() });
        demo.connectivity.subscribe((on) => (transport.online = on));
        transports.set(user.id, transport);
        const engine = createSyncEngine(
          { db: await factory.open(user.id), transport, connectivity: demo.connectivity, userId: user.id, householdId, uuid: randomUUID },
          { pushDebounceMs: 5, nudgeDebounceMs: 5 },
        );
        await engine.start();
        return engine;
      },
      wipe: (userId, engine) => wipeLocalData({ engine, factory, userId }),
      countUnsent: (userId) => countUnsentChanges(factory, userId),
    },
  };
  return { backend, factory, transports };
}
