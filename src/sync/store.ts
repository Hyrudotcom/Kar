/** SQLite persistence for the sync engine. All methods assume the caller serializes access. */
import type {
  FailedMutation,
  HistoryEntry,
  HouseholdRow,
  ListItemRow,
  Mutation,
  MutationResult,
  SqlDriver,
  SqlValue,
  Unit,
  Uuid,
} from '@/src/contracts';
import { migrate } from './schema';
import type { AckedLogEntry, LocalMeta, OutboxEntry } from './types';

const ITEM_COLUMNS = [
  'id', 'household_id', 'name', 'normalized_name', 'quantity', 'unit', 'note', 'checked', 'checked_at',
  'position', 'exclude_from_comparison', 'created_by', 'created_at', 'updated_by', 'updated_at',
  'deleted_at', 'deleted_by', 'server_seq',
] as const;

type Row = Record<string, SqlValue>;

const str = (v: SqlValue | undefined): string => (v === null || v === undefined ? "" : String(v));
const strOrNull = (v: SqlValue | undefined): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: SqlValue | undefined): number => (v === null || v === undefined ? 0 : Number(v));

function parseJson<T>(v: SqlValue | undefined): T | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return null;
  }
}

export function rowToItem(r: Row): ListItemRow {
  return {
    id: str(r.id),
    household_id: str(r.household_id),
    name: str(r.name),
    normalized_name: str(r.normalized_name),
    quantity: num(r.quantity),
    unit: str(r.unit) as Unit,
    note: str(r.note),
    checked: num(r.checked) === 1,
    checked_at: strOrNull(r.checked_at),
    position: num(r.position),
    exclude_from_comparison: num(r.exclude_from_comparison) === 1,
    created_by: strOrNull(r.created_by),
    created_at: str(r.created_at),
    updated_by: strOrNull(r.updated_by),
    updated_at: str(r.updated_at),
    deleted_at: strOrNull(r.deleted_at),
    deleted_by: strOrNull(r.deleted_by),
    server_seq: num(r.server_seq),
  };
}

function itemParams(i: ListItemRow): SqlValue[] {
  return [
    i.id, i.household_id, i.name, i.normalized_name, Number(i.quantity), i.unit, i.note ?? '', i.checked ? 1 : 0,
    i.checked_at, Number(i.position), i.exclude_from_comparison ? 1 : 0, i.created_by, i.created_at, i.updated_by,
    i.updated_at, i.deleted_at, i.deleted_by, Number(i.server_seq),
  ];
}

function rowToOutbox(r: Row): OutboxEntry {
  return {
    seq: num(r.seq),
    mutation: {
      id: str(r.id),
      household_id: str(r.household_id),
      kind: str(r.kind),
      payload: parseJson(r.payload),
      client_created_at: str(r.client_created_at),
    } as Mutation,
    state: str(r.state) === 'acked' ? 'acked' : 'pending',
    ackedSeq: r.acked_seq === null || r.acked_seq === undefined ? null : num(r.acked_seq),
    result: parseJson<MutationResult>(r.result),
    attempts: num(r.attempts),
    nextAttemptAt: num(r.next_attempt_at),
    lastError: strOrNull(r.last_error),
    localMeta: parseJson<LocalMeta>(r.local_meta),
  };
}

export interface LoadedState {
  householdId: Uuid | null;
  userId: Uuid | null;
  lastSeq: number;
  household: HouseholdRow | null;
  items: Map<Uuid, ListItemRow>;
  outbox: OutboxEntry[];
  failed: FailedMutation[];
  aliases: Map<Uuid, Uuid>;
}

export class LocalStore {
  constructor(readonly db: SqlDriver) {}

  async init(): Promise<void> {
    await migrate(this.db);
  }

  async load(): Promise<LoadedState> {
    const meta = new Map<string, string>();
    for (const r of await this.db.all<{ key: string; value: string }>('select key, value from meta')) meta.set(r.key, r.value);
    const items = new Map<Uuid, ListItemRow>();
    for (const r of await this.db.all<Row>(`select ${ITEM_COLUMNS.join(', ')} from server_items`)) {
      const it = rowToItem(r);
      items.set(it.id, it);
    }
    const outbox = (await this.db.all<Row>('select * from outbox order by seq')).map(rowToOutbox);
    const aliases = new Map<Uuid, Uuid>();
    for (const r of await this.db.all<{ alias_id: string; target_id: string }>('select alias_id, target_id from aliases')) {
      aliases.set(r.alias_id, r.target_id);
    }
    return {
      householdId: meta.get('household_id') ?? null,
      userId: meta.get('user_id') ?? null,
      lastSeq: Number(meta.get('last_seq') ?? 0),
      household: meta.has('household') ? parseJson<HouseholdRow>(meta.get('household')!) : null,
      items,
      outbox,
      failed: await this.loadFailed(),
      aliases,
    };
  }

  async loadFailed(): Promise<FailedMutation[]> {
    const rows = await this.db.all<Row>('select id, kind, item_name, reason, failed_at from failed_mutations order by failed_at, id');
    return rows.map((r) => ({
      mutationId: str(r.id),
      kind: str(r.kind) as Mutation['kind'],
      itemName: str(r.item_name),
      reason: str(r.reason) as FailedMutation['reason'],
      failedAt: num(r.failed_at),
    }));
  }

  setMeta(key: string, value: string): Promise<unknown> {
    return this.db.run('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value', [key, value]);
  }

  async upsertItems(items: readonly ListItemRow[]): Promise<void> {
    const placeholders = ITEM_COLUMNS.map(() => '?').join(', ');
    const updates = ITEM_COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
    const sql = `insert into server_items (${ITEM_COLUMNS.join(', ')}) values (${placeholders})
      on conflict(id) do update set ${updates} where excluded.server_seq >= server_items.server_seq`;
    for (const it of items) await this.db.run(sql, itemParams(it));
  }

  clearItems(): Promise<unknown> {
    return this.db.run('delete from server_items');
  }

  async insertOutbox(m: Mutation, meta: LocalMeta | null): Promise<number> {
    const res = await this.db.run(
      `insert into outbox (id, household_id, kind, payload, client_created_at, local_meta) values (?, ?, ?, ?, ?, ?)`,
      [m.id, m.household_id, m.kind, JSON.stringify(m.payload), m.client_created_at, meta ? JSON.stringify(meta) : null],
    );
    return res.lastInsertRowId;
  }

  markAcked(id: Uuid, ackedSeq: number, result: MutationResult): Promise<unknown> {
    return this.db.run(`update outbox set state = 'acked', acked_seq = ?, result = ?, last_error = null where id = ?`, [
      ackedSeq,
      JSON.stringify(result),
      id,
    ]);
  }

  markRetry(id: Uuid, attempts: number, nextAttemptAt: number, error: string): Promise<unknown> {
    return this.db.run('update outbox set attempts = ?, next_attempt_at = ?, last_error = ? where id = ?', [
      attempts,
      nextAttemptAt,
      error,
      id,
    ]);
  }

  updatePayload(id: Uuid, payload: Mutation['payload']): Promise<unknown> {
    return this.db.run('update outbox set payload = ? where id = ?', [JSON.stringify(payload), id]);
  }

  /** Gives an outbox row a fresh mutation id (the old id has a stored result on the server). */
  renameOutbox(oldId: Uuid, newId: Uuid): Promise<unknown> {
    return this.db.run('update outbox set id = ? where id = ?', [newId, oldId]);
  }

  setOutboxHousehold(householdId: Uuid): Promise<unknown> {
    return this.db.run("update outbox set household_id = ? where state = 'pending'", [householdId]);
  }

  deleteOutbox(ids: readonly Uuid[]): Promise<unknown> {
    return this.deleteIn('outbox', 'id', ids);
  }

  deleteAckedUpTo(seq: number): Promise<unknown> {
    return this.db.run("delete from outbox where state = 'acked' and acked_seq <= ?", [seq]);
  }

  deleteAllAcked(): Promise<unknown> {
    return this.db.run("delete from outbox where state = 'acked'");
  }

  insertAlias(aliasId: Uuid, targetId: Uuid): Promise<unknown> {
    return this.db.run('insert or replace into aliases (alias_id, target_id) values (?, ?)', [aliasId, targetId]);
  }

  clearAliases(): Promise<unknown> {
    return this.db.run('delete from aliases');
  }

  logAck(e: AckedLogEntry): Promise<unknown> {
    return this.db.run(
      'insert or replace into acked_log (id, kind, payload, result, local_meta, acked_at) values (?, ?, ?, ?, ?, ?)',
      [e.id, e.kind, JSON.stringify(e.payload), JSON.stringify(e.result), e.localMeta ? JSON.stringify(e.localMeta) : null, e.ackedAt],
    );
  }

  async getAckLog(id: Uuid): Promise<AckedLogEntry | null> {
    const r = await this.db.get<Row>('select * from acked_log where id = ?', [id]);
    if (!r) return null;
    return {
      id: str(r.id),
      kind: str(r.kind) as AckedLogEntry['kind'],
      payload: parseJson(r.payload) as AckedLogEntry['payload'],
      result: parseJson<MutationResult>(r.result)!,
      localMeta: parseJson<LocalMeta>(r.local_meta),
      ackedAt: num(r.acked_at),
    };
  }

  /** clear_checked results whose payload contained itemId (used to make undo of "Wissen" exact). */
  async clearResultsContaining(itemId: Uuid): Promise<MutationResult[]> {
    const rows = await this.db.all<Row>("select payload, result from acked_log where kind = 'clear_checked'");
    const out: MutationResult[] = [];
    for (const r of rows) {
      const p = parseJson<{ item_ids: string[] }>(r.payload);
      const res = parseJson<MutationResult>(r.result);
      if (p?.item_ids?.includes(itemId) && res) out.push(res);
    }
    return out;
  }

  pruneAckLog(before: number): Promise<unknown> {
    return this.db.run('delete from acked_log where acked_at < ?', [before]);
  }

  insertFailed(f: FailedMutation, m: Mutation): Promise<unknown> {
    return this.db.run(
      'insert or replace into failed_mutations (id, kind, payload, item_name, reason, failed_at) values (?, ?, ?, ?, ?, ?)',
      [f.mutationId, f.kind, JSON.stringify(m.payload), f.itemName, f.reason, f.failedAt],
    );
  }

  deleteFailed(ids: readonly Uuid[]): Promise<unknown> {
    return this.deleteIn('failed_mutations', 'id', ids);
  }

  async bumpHistory(normalized: string, unit: Unit, displayName: string, at: number): Promise<void> {
    await this.db.run(
      `insert into history (normalized_name, unit, display_name, use_count, last_used_at) values (?, ?, ?, 1, ?)
       on conflict(normalized_name, unit) do update set use_count = use_count + 1, display_name = excluded.display_name,
       last_used_at = excluded.last_used_at`,
      [normalized, unit, displayName, at],
    );
  }

  async history(limit: number): Promise<HistoryEntry[]> {
    const rows = await this.db.all<Row>(
      'select normalized_name, unit, display_name, use_count, last_used_at from history order by use_count desc, last_used_at desc, normalized_name limit ?',
      [limit],
    );
    return rows.map((r) => ({
      normalized_name: str(r.normalized_name),
      unit: str(r.unit) as Unit,
      display_name: str(r.display_name),
      use_count: num(r.use_count),
      last_used_at: num(r.last_used_at),
    }));
  }

  async pruneTombstones(beforeIso: string): Promise<void> {
    await this.db.run('delete from server_items where deleted_at is not null and deleted_at < ?', [beforeIso]);
  }

  clearPriceCache(): Promise<unknown> {
    return this.db.run('delete from price_cache');
  }

  private async deleteIn(table: string, col: string, ids: readonly Uuid[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      await this.db.run(`delete from ${table} where ${col} in (${chunk.map(() => '?').join(', ')})`, [...chunk]);
    }
  }
}
