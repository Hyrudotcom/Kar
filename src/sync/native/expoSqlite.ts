/**
 * App SqlDriver backed by expo-sqlite (iOS, Android, web via OPFS/wasm).
 *
 * The driver is not re-entrant across independent callers: all statements issued while a
 * transaction is open are considered part of it. The sync engine serializes every access to the
 * database through one mutex; other modules must go through the engine (e.g. the price cache API)
 * instead of using the driver concurrently.
 */
import * as SQLite from 'expo-sqlite';
import type { SqlDriver, SqlDriverFactory, SqlValue, Uuid } from '@/src/contracts';

export class ExpoSqliteDriver implements SqlDriver {
  private depth = 0;
  private closed = false;

  constructor(readonly db: SQLite.SQLiteDatabase) {}

  async exec(sql: string): Promise<void> {
    await this.db.execAsync(sql);
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
    const r = await this.db.runAsync(sql, params);
    return { changes: r.changes, lastInsertRowId: Number(r.lastInsertRowId) };
  }

  all<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, params);
  }

  get<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return this.db.getFirstAsync<T>(sql, params);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const sp = `sp_${this.depth}`;
    await this.db.execAsync(this.depth === 0 ? 'begin immediate' : `savepoint ${sp}`);
    this.depth++;
    try {
      const out = await fn();
      this.depth--;
      await this.db.execAsync(this.depth === 0 ? 'commit' : `release ${sp}`);
      return out;
    } catch (e) {
      this.depth--;
      try {
        await this.db.execAsync(this.depth === 0 ? 'rollback' : `rollback to ${sp}; release ${sp}`);
      } catch {
        /* the transaction may already be gone (e.g. SQLITE_FULL rolled it back) */
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.db.closeAsync();
  }
}

export function databaseNameFor(userId: Uuid): string {
  if (!/^[0-9a-zA-Z-]+$/.test(userId)) throw new Error('invalid user id');
  return `gb-${userId}.db`;
}

/** Per-user database files `gb-<userId>.db` in the default expo-sqlite directory. */
export class ExpoSqliteFactory implements SqlDriverFactory {
  private handles = new Map<Uuid, ExpoSqliteDriver>();

  constructor(private readonly options: { inMemory?: boolean } = {}) {}

  async open(userId: Uuid): Promise<ExpoSqliteDriver> {
    const existing = this.handles.get(userId);
    if (existing) {
      this.handles.delete(userId);
      await existing.close().catch(() => undefined);
    }
    const db = await SQLite.openDatabaseAsync(this.options.inMemory ? ':memory:' : databaseNameFor(userId));
    const driver = new ExpoSqliteDriver(db);
    this.handles.set(userId, driver);
    return driver;
  }

  async destroy(userId: Uuid): Promise<void> {
    const h = this.handles.get(userId);
    this.handles.delete(userId);
    if (h) await h.close().catch(() => undefined);
    if (this.options.inMemory) return;
    try {
      await SQLite.deleteDatabaseAsync(databaseNameFor(userId));
    } catch (e) {
      // Missing file is fine (already wiped); anything else must surface: user data would remain.
      if (!/not\s*found|does not exist|no such file/i.test(String((e as Error)?.message ?? e))) throw e;
    }
  }
}
