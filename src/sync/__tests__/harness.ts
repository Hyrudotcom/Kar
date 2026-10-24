import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Uuid } from '@/src/contracts';
import { createSyncEngine, type SyncEngineOptions } from '../engine';
import { BetterSqliteDriver, BetterSqliteFactory } from '../node/betterSqlite';
import { FakeClock } from '../testing/fakeClock';
import { FakeServer, FakeTransport } from '../testing/fakeServer';
import type { GoedSyncEngine } from '../types';
import { ManualConnectivity } from '../util';

export const uuid = (): Uuid => randomUUID();

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gb-sync-'));
}

export interface Device {
  userId: Uuid;
  householdId: Uuid;
  engine: GoedSyncEngine;
  transport: FakeTransport;
  connectivity: ManualConnectivity;
  factory: BetterSqliteFactory;
  db: BetterSqliteDriver;
  clock: FakeClock;
  /** Simulates killing the app (DB handle dropped without stop()) and launching it again. */
  restart(): Promise<void>;
  goOffline(): void;
  goOnline(): void;
  names(): string[];
}

export interface DeviceOptions {
  userId?: Uuid;
  householdId: Uuid;
  clock?: FakeClock;
  dir?: string;
  engine?: SyncEngineOptions;
  online?: boolean;
  start?: boolean;
}

export async function makeDevice(server: FakeServer, opts: DeviceOptions): Promise<Device> {
  const userId = opts.userId ?? uuid();
  const clock = opts.clock ?? new FakeClock();
  const factory = new BetterSqliteFactory(opts.dir ?? tempDir());
  const connectivity = new ManualConnectivity(opts.online ?? true);
  const transport = new FakeTransport(server, userId, { online: opts.online ?? true });
  const engineOpts: SyncEngineOptions = { random: () => 0.5, ...opts.engine };

  const dev = {
    userId,
    householdId: opts.householdId,
    transport,
    connectivity,
    factory,
    clock,
  } as Device;

  const boot = async () => {
    dev.db = await factory.open(userId);
    dev.engine = createSyncEngine(
      { db: dev.db, transport, connectivity, userId, householdId: dev.householdId, clock, uuid },
      engineOpts,
    );
    if (opts.start !== false) await dev.engine.start();
  };
  await boot();

  dev.restart = async () => {
    // A killed process runs no cleanup: timers die with it, the DB handle is dropped mid-whatever.
    void dev.engine.stop();
    dev.db.kill();
    await boot();
  };
  dev.goOffline = () => {
    transport.online = false;
    connectivity.set(false);
  };
  dev.goOnline = () => {
    transport.online = true;
    connectivity.set(true);
  };
  dev.names = () => dev.engine.getSnapshot().open.map((i) => `${i.name}:${i.quantity}${i.unit === 'stuk' ? '' : i.unit}`);
  return dev;
}

export function household(server: FakeServer, ...userIds: Uuid[]): Uuid {
  const [owner, ...rest] = userIds;
  const id = server.createHousehold(owner!);
  for (const u of rest) server.addMember(id, u);
  return id;
}

/** Two members of one household, each on their own device. */
export async function twoDevices(engine?: SyncEngineOptions) {
  const server = new FakeServer();
  const a = uuid();
  const b = uuid();
  const hh = household(server, a, b);
  const clock = new FakeClock();
  const anna = await makeDevice(server, { userId: a, householdId: hh, clock, engine });
  const bram = await makeDevice(server, { userId: b, householdId: hh, clock, engine });
  await anna.engine.syncNow();
  await bram.engine.syncNow();
  return { server, hh, clock, anna, bram };
}

export async function outboxRows(dev: Device): Promise<{ id: string; kind: string; state: string; attempts: number }[]> {
  return dev.db.all('select id, kind, state, attempts from outbox order by seq');
}
