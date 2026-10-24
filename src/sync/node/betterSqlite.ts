/**
 * Node SqlDriver backed by better-sqlite3 (tests, scripts). Never import from app code.
 */
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SqlDriver, SqlDriverFactory, SqlValue, Uuid } from '@/src/contracts';

export class BetterSqliteDriver implements SqlDriver {
  private depth = 0;
  private closed = false;

  constructor(readonly db: Database.Database) {}

  static open(file: string): BetterSqliteDriver {
    return new BetterSqliteDriver(new Database(file));
  }

  private check() {
    if (this.closed) throw new Error('database is closed');
  }

  async exec(sql: string): Promise<void> {
    this.check();
    this.db.exec(sql);
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number; lastInsertRowId: number }> {
    this.check();
    const r = this.db.prepare(sql).run(...params);
    return { changes: r.changes, lastInsertRowId: Number(r.lastInsertRowid) };
  }

  async all<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    this.check();
    return this.db.prepare(sql).all(...params) as T[];
  }

  async get<T = Record<string, SqlValue>>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    this.check();
    return (this.db.prepare(sql).get(...params) as T | undefined) ?? null;
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.check();
    const sp = `sp_${this.depth}`;
    this.db.exec(this.depth === 0 ? 'begin immediate' : `savepoint ${sp}`);
    this.depth++;
    try {
      const out = await fn();
      this.depth--;
      this.db.exec(this.depth === 0 ? 'commit' : `release ${sp}`);
      return out;
    } catch (e) {
      this.depth--;
      if (!this.closed) {
        if (this.depth === 0) {
          if (this.db.inTransaction) this.db.exec('rollback');
        } else {
          this.db.exec(`rollback to ${sp}; release ${sp}`);
        }
      }
      throw e;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Test helper: simulates a process kill (no commit of an open transaction, handle dropped). */
  kill(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close(); // an open transaction is rolled back by SQLite, exactly like a crash
  }
}

/** One file per user: `<directory>/gb-<userId>.db`. */
export class BetterSqliteFactory implements SqlDriverFactory {
  private open_ = new Map<Uuid, BetterSqliteDriver>();
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
  }

  fileFor(userId: Uuid): string {
    if (!/^[0-9a-zA-Z-]+$/.test(userId)) throw new Error('invalid user id');
    return path.join(this.directory, `gb-${userId}.db`);
  }

  async open(userId: Uuid): Promise<BetterSqliteDriver> {
    const d = BetterSqliteDriver.open(this.fileFor(userId));
    this.open_.get(userId)?.close();
    this.open_.set(userId, d);
    return d;
  }

  async destroy(userId: Uuid): Promise<void> {
    await this.open_.get(userId)?.close();
    this.open_.delete(userId);
    const f = this.fileFor(userId);
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(f + suffix, { force: true });
  }

  exists(userId: Uuid): boolean {
    return fs.existsSync(this.fileFor(userId));
  }
}
