/**
 * Local SQLite schema for `gb-<userId>.db` (docs/architecture.md 5.1).
 *
 * Additions owned by the sync builder (internal, not part of the contract):
 *  - outbox.local_meta: JSON with the local simulation at enqueue time (undo of a restore needs the
 *    previous quantity, which the server result does not carry).
 *  - acked_log: results of acknowledged mutations, kept for 24 h after the pull caught up, so
 *    `revert_add` can still be resolved after the outbox row is gone.
 *  - aliases: add_item ids the server merged/restored into another row (mirror of private.item_aliases).
 */
import type { SqlDriver } from '@/src/contracts';

export const SCHEMA_VERSION = 1;

const V1 = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists server_items (
  id text primary key, household_id text not null, name text not null, normalized_name text not null,
  quantity real not null, unit text not null, note text not null, checked integer not null,
  checked_at text, position integer not null, exclude_from_comparison integer not null,
  created_by text, created_at text not null, updated_by text, updated_at text not null,
  deleted_at text, deleted_by text, server_seq integer not null);
create table if not exists outbox (
  seq integer primary key autoincrement, id text not null unique, household_id text not null,
  kind text not null, payload text not null, client_created_at text not null,
  state text not null default 'pending' check (state in ('pending','acked')),
  acked_seq integer, result text, attempts integer not null default 0,
  next_attempt_at integer not null default 0, last_error text, local_meta text);
create table if not exists failed_mutations (id text primary key, kind text not null, payload text not null,
  item_name text not null, reason text not null, failed_at integer not null);
create table if not exists history (normalized_name text not null, unit text not null, display_name text not null,
  use_count integer not null default 0, last_used_at integer not null, primary key (normalized_name, unit));
create table if not exists price_cache (id integer primary key check (id = 1), result text not null,
  list_fingerprint text not null, computed_at integer not null);
create table if not exists acked_log (id text primary key, kind text not null, payload text not null,
  result text not null, local_meta text, acked_at integer not null);
create table if not exists aliases (alias_id text primary key, target_id text not null);
`;

/** Creates / migrates the schema. Idempotent; safe on every open. */
export async function migrate(db: SqlDriver): Promise<void> {
  await db.exec('pragma journal_mode = wal;');
  await db.exec('create table if not exists meta (key text primary key, value text not null);');
  const row = await db.get<{ value: string }>("select value from meta where key = 'schema_version'");
  const version = row ? Number(row.value) : 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(`Local database schema ${version} is newer than this app (${SCHEMA_VERSION}).`);
  }
  if (version < 1) {
    await db.transaction(async () => {
      await db.exec(V1);
      await db.run("insert or replace into meta (key, value) values ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    });
  }
}
