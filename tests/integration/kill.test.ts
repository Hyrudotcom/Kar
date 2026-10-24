/**
 * (c) The process is killed mid-push (real SIGKILL of a child process running the engine). On the
 * next start the persistent outbox is replayed; apply_mutations is idempotent, so nothing is lost or
 * applied twice.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import type { Uuid } from '@/src/contracts';

import {
  ANON_KEY,
  API_URL,
  closeAll,
  db,
  ensureHousehold,
  openDevice,
  serverRows,
  settle,
  signInUser,
  tempDir,
  type Device,
  type TestUser,
} from './stack';

jest.setTimeout(120_000);
afterAll(closeAll);

const ROOT = path.resolve(__dirname, '../..');

async function runChildUntilKilled(user: TestUser, householdId: Uuid, dir: string, mode: 'before_send' | 'after_server', count: number, batch = 100) {
  const { data } = await user.client.auth.getSession();
  const session = data.session!;
  // One process (node with the tsx loader), so SIGKILL really kills the engine, not a wrapper.
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'child/pushAndDie.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      GB_API_URL: API_URL,
      GB_ANON_KEY: ANON_KEY,
      GB_ACCESS_TOKEN: session.access_token,
      GB_REFRESH_TOKEN: session.refresh_token,
      GB_USER_ID: user.id,
      GB_HOUSEHOLD_ID: householdId,
      GB_DIR: dir,
      GB_MODE: mode,
      GB_COUNT: String(count),
      GB_BATCH: String(batch),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => (err += String(d)));
  const marks: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child timeout. stdout=${out} stderr=${err}`));
    }, 60_000);
    child.stdout.on('data', (d) => {
      out += String(d);
      for (const line of out.split('\n')) {
        if (line.startsWith(`MARK ${mode}`) && !marks.includes(line)) {
          marks.push(line);
          child.kill('SIGKILL'); // no cleanup, no ack transaction, like the OS killing the app
          clearTimeout(timer);
          resolve();
        }
      }
    });
    child.on('exit', (code, signal) => {
      if (signal !== 'SIGKILL') {
        clearTimeout(timer);
        reject(new Error(`child exited early (${code}). stdout=${out} stderr=${err}`));
      }
    });
  });
  await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r(null) : child.on('exit', r)));
  return { marks, stdout: out };
}

async function mutationLogCount(userId: Uuid): Promise<number> {
  const { rows } = await db().query('select count(*)::int as n from private.mutations where user_id = $1', [userId]);
  return rows[0].n as number;
}

describe('(c) killed mid-push', () => {
  let device: Device | null = null;
  afterEach(async () => {
    await device?.dispose();
    device = null;
  });

  test('killed after the server committed but before the ack: replay returns the stored results, no duplicates', async () => {
    const user = await signInUser('kill-after');
    const hh = await ensureHousehold(user.client);
    const dir = tempDir();
    const { stdout } = await runChildUntilKilled(user, hh, dir, 'after_server', 40);
    expect(stdout).toContain('MARK queued 41');
    // The server already has every row once.
    expect(await serverRows(hh)).toHaveLength(40);
    expect(await mutationLogCount(user.id)).toBe(41);

    // App starts again on the same file: the outbox still holds all 41 mutations.
    device = await openDevice(user, hh, { dir });
    await settle([device]);
    const replay = device.transport.results.flatMap((r) => (r.ok ? r.results : []));
    expect(replay).toHaveLength(41);
    expect(replay.every((r) => r.replayed === true)).toBe(true);
    expect(await mutationLogCount(user.id)).toBe(41);
    const truth = await serverRows(hh);
    expect(truth).toHaveLength(40);
    expect(device.view()).toEqual(truth);
    expect(truth.find((r) => r.includes('|Kill 0|'))).toMatch(/\|Kill 0\|5\|stuk\|/);
    expect(device.engine.getStatus()).toMatchObject({ pendingCount: 0, failed: [] });
  });

  test('killed after the first of several batches committed: the rest is sent once, the first batch is replayed', async () => {
    const user = await signInUser('kill-batch');
    const hh = await ensureHousehold(user.client);
    const dir = tempDir();
    const { marks } = await runChildUntilKilled(user, hh, dir, 'after_server', 25, 10);
    expect(marks[0]).toMatch(/^MARK after_server 10 /);
    expect(await serverRows(hh)).toHaveLength(10);

    device = await openDevice(user, hh, { dir });
    await settle([device]);
    const results = device.transport.results.flatMap((r) => (r.ok ? r.results : []));
    expect(results).toHaveLength(26);
    expect(results.filter((r) => r.replayed).length).toBe(10);
    const truth = await serverRows(hh);
    expect(truth).toHaveLength(25);
    expect(device.view()).toEqual(truth);
    expect(await mutationLogCount(user.id)).toBe(26);
  });

  test('killed before the request left the device: everything is sent once on the next start', async () => {
    const user = await signInUser('kill-before');
    const hh = await ensureHousehold(user.client);
    const dir = tempDir();
    await runChildUntilKilled(user, hh, dir, 'before_send', 15);
    expect(await serverRows(hh)).toHaveLength(0);
    device = await openDevice(user, hh, { dir });
    await settle([device]);
    const results = device.transport.results.flatMap((r) => (r.ok ? r.results : []));
    expect(results).toHaveLength(16);
    expect(results.some((r) => r.replayed)).toBe(false);
    expect(await serverRows(hh)).toHaveLength(15);
    expect(device.view()).toEqual(await serverRows(hh));
  });

  test('lost response (network drop after commit) in a live session: the retry is idempotent', async () => {
    const user = await signInUser('lost-resp');
    const hh = await ensureHousehold(user.client);
    device = await openDevice(user, hh);
    device.transport.loseResponses = 2;
    for (let i = 0; i < 5; i++) await device.engine.addItem({ name: `Item ${i}`, quantity: 1, unit: 'stuk' });
    await device.engine.addItem({ name: 'Item 0', quantity: 2, unit: 'stuk' });
    await settle([device], 60_000);
    const truth = await serverRows(hh);
    expect(truth).toHaveLength(5);
    expect(truth.find((r) => r.includes('|Item 0|'))).toMatch(/\|Item 0\|3\|/);
    expect(device.view()).toEqual(truth);
  });
});
