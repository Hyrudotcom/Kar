import * as fs from 'node:fs';
import { BetterSqliteDriver, BetterSqliteFactory } from '../node/betterSqlite';
import { countUnsentChanges, wipeLocalData } from '../session';
import { FakeServer } from '../testing/fakeServer';
import { household, makeDevice, tempDir, twoDevices, uuid } from './harness';

describe('SqlDriver (better-sqlite3)', () => {
  test('transaction commits, rolls back on throw, supports nesting via savepoints', async () => {
    const d = BetterSqliteDriver.open(':memory:');
    await d.exec('create table t (v integer)');
    await d.transaction(async () => {
      await d.run('insert into t values (1)');
    });
    await expect(
      d.transaction(async () => {
        await d.run('insert into t values (2)');
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    await d.transaction(async () => {
      await d.run('insert into t values (3)');
      await d
        .transaction(async () => {
          await d.run('insert into t values (4)');
          throw new Error('inner');
        })
        .catch(() => undefined);
    });
    expect((await d.all<{ v: number }>('select v from t order by v')).map((r) => r.v)).toEqual([1, 3]);
    expect(await d.get('select v from t where v = 99')).toBeNull();
    await d.close();
  });
});

describe('local wipe (logout / leave / removal)', () => {
  test('wipeLocalData stops the engine and deletes gb-<userId>.db (list, outbox, history, failed)', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dir = tempDir();
    const dev = await makeDevice(server, { userId: user, householdId: hh, dir, online: false });
    await dev.engine.addItem({ name: 'Geheim', quantity: 1, unit: 'stuk' });
    expect(dev.factory.exists(user)).toBe(true);
    expect(fs.existsSync(dev.factory.fileFor(user))).toBe(true);
    await wipeLocalData({ engine: dev.engine, factory: dev.factory, userId: user });
    expect(dev.factory.exists(user)).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.includes(user))).toEqual([]);
    // a fresh start has nothing left
    const again = await makeDevice(server, { userId: user, householdId: hh, dir, online: false });
    expect(again.names()).toEqual([]);
    expect(await again.engine.getHistory()).toEqual([]);
    expect(again.engine.getStatus().pendingCount).toBe(0);
  });

  test('removal flow: membership lost -> failed list for "Kopieer als tekst" -> wipe', async () => {
    const { bram, server, hh } = await twoDevices();
    bram.goOffline();
    await bram.engine.addItem({ name: 'Wijn', quantity: 2, unit: 'stuk' });
    server.removeMember(hh, bram.userId);
    let text = '';
    bram.engine.onMembershipLost(() => {
      text = bram.engine.unsent().text;
    });
    bram.goOnline();
    await bram.engine.whenIdle();
    expect(text).toBe('1 wijziging kon niet worden opgeslagen: Wijn.\n- Wijn: toevoegen (je bent geen lid meer van dit huishouden)');
    await wipeLocalData({ engine: bram.engine, factory: bram.factory, userId: bram.userId });
    expect(bram.factory.exists(bram.userId)).toBe(false);
  });

  test('countUnsentChanges reports another user\'s pending outbox before switching accounts', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dir = tempDir();
    const dev = await makeDevice(server, { userId: user, householdId: hh, dir, online: false });
    await dev.engine.addItem({ name: 'A', quantity: 1, unit: 'stuk' });
    await dev.engine.addItem({ name: 'B', quantity: 1, unit: 'stuk' });
    await dev.engine.dispose();
    const factory = new BetterSqliteFactory(dir);
    expect(await countUnsentChanges(factory, user)).toBe(2);
    expect(await countUnsentChanges(factory, uuid())).toBe(0); // no file yet: creates an empty one
  });
});

describe('triggers', () => {
  test('safety-net pull every 60 s while active, none while backgrounded; foreground syncs', async () => {
    const { anna, bram, clock } = await twoDevices({ nudgeDebounceMs: 10_000_000 });
    await anna.engine.addItem({ name: 'X', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    bram.engine.setAppActive(false);
    await clock.advance(120_000);
    await bram.engine.whenIdle();
    expect(bram.names()).toEqual([]);
    bram.engine.setAppActive(true); // foreground -> sync
    await bram.engine.whenIdle();
    expect(bram.names()).toEqual(['X:1']);
    await anna.engine.addItem({ name: 'Y', quantity: 1, unit: 'stuk' });
    await anna.engine.syncNow();
    await clock.advance(60_000);
    await bram.engine.whenIdle();
    expect(bram.names()).toEqual(['Y:1', 'X:1']);
  });

  test('stop(): no more network calls, commands become no-ops', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh });
    await dev.engine.whenIdle();
    await dev.engine.stop();
    const calls = dev.transport.calls.length;
    const r = await dev.engine.addItem({ name: 'Na stop', quantity: 1, unit: 'stuk' });
    expect(r.outcome).toBe('noop');
    await dev.clock.advance(120_000);
    await dev.engine.syncNow();
    expect(dev.transport.calls.length).toBe(calls);
  });
});

describe('price cache and clock skew', () => {
  test('price cache round-trips through the engine and is wiped with the file', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dir = tempDir();
    const dev = await makeDevice(server, { userId: user, householdId: hh, dir });
    expect(await dev.engine.readPriceCache()).toBeNull();
    await dev.engine.writePriceCache({ result: { state: 'unavailable' }, listFingerprint: 'abc', computedAt: 5 });
    await dev.engine.writePriceCache({ result: { state: 'unavailable', n: 2 }, listFingerprint: 'def', computedAt: 6 });
    expect(await dev.engine.readPriceCache()).toEqual({ result: { state: 'unavailable', n: 2 }, listFingerprint: 'def', computedAt: 6 });
    await wipeLocalData({ engine: dev.engine, factory: dev.factory, userId: user });
    const again = await makeDevice(server, { userId: user, householdId: hh, dir });
    expect(await again.engine.readPriceCache()).toBeNull();
  });

  test('a backoff persisted by a clock that ran ahead never holds a row longer than 60 s', async () => {
    const server = new FakeServer();
    const user = uuid();
    const hh = household(server, user);
    const dev = await makeDevice(server, { userId: user, householdId: hh, online: false });
    await dev.engine.addItem({ name: 'Scheef', quantity: 1, unit: 'stuk' });
    await dev.db.run('update outbox set next_attempt_at = ?, attempts = 3', [dev.clock.now() + 86_400_000]);
    await dev.restart();
    dev.goOnline();
    await dev.engine.whenIdle();
    expect(server.list(hh)).toHaveLength(0);
    await dev.clock.advance(60_000);
    await dev.engine.whenIdle();
    expect(server.list(hh)).toHaveLength(1);
  });
});
