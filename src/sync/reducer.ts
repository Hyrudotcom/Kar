/**
 * Pure reducer: visible state = reduce(server_items, outbox rows in seq order).
 *
 * Mirrors the server rules of docs/architecture.md 4.1 so the optimistic UI matches what the server
 * will most likely decide. The server stays authoritative: every row is replaced by the pulled
 * server state as soon as a pull catches up with the acknowledged mutation.
 *
 * - Pending rows are simulated with the server rules against the local state.
 * - Acknowledged rows (not yet covered by a pull) are replayed from the *server result*
 *   (merge/restore target, affected_ids, server_seq as position), so rows do not flicker between
 *   the ack and the pull.
 */
import type { ListItemRow, LocalOutcome, Mutation, Uuid, VisibleItem } from '@/src/contracts';
import { normalizeName } from '@/src/shared/normalize';
import type { OutboxEntry } from './types';
import { isValidQuantity, roundQuantity } from './validate';

export interface SimResult {
  outcome: LocalOutcome;
  /** Item the mutation affected locally (after alias / dedupe), null when nothing matched. */
  targetId: Uuid | null;
  /** add_item -> restored: quantity before the restore. */
  prevQuantity?: number;
  /** clear_checked: ids tombstoned locally. */
  affectedIds?: Uuid[];
  /** Locally this mutation would be rejected by the server (target missing/deleted, invalid result). */
  wouldReject?: 'deleted' | 'not_found' | 'invalid';
}

export interface ReduceInput {
  base: ReadonlyMap<Uuid, ListItemRow>;
  /** Outbox entries of the current household, ascending seq. */
  entries: readonly OutboxEntry[];
  /** Persisted aliases (add id -> target id) from earlier acks. */
  aliases: ReadonlyMap<Uuid, Uuid>;
  userId: Uuid;
}

export interface ReduceOutput {
  items: Map<Uuid, VisibleItem>;
  /** Simulation per mutation id (pending and acked entries). */
  sims: Map<Uuid, SimResult>;
  /** Aliases known after the replay (persisted + derived from acked results + local merges). */
  aliases: Map<Uuid, Uuid>;
}

export function reduce(input: ReduceInput): ReduceOutput {
  const rows = new Map<Uuid, ListItemRow>(input.base);
  const owned = new Set<Uuid>(); // rows already copied (copy-on-write)
  const pendingIds = new Set<Uuid>();
  const aliases = new Map<Uuid, Uuid>(input.aliases);
  const sims = new Map<Uuid, SimResult>();
  let maxPos = 0;
  for (const r of rows.values()) if (r.position > maxPos) maxPos = r.position;

  const resolve = (id: Uuid): Uuid => {
    let cur = id;
    for (let i = 0; i < 8; i++) {
      const next = aliases.get(cur);
      if (next === undefined || next === cur) return cur;
      cur = next;
    }
    return cur;
  };
  const writable = (id: Uuid): ListItemRow | undefined => {
    const r = rows.get(id);
    if (!r) return undefined;
    if (owned.has(id)) return r;
    const copy = { ...r };
    rows.set(id, copy);
    owned.add(id);
    return copy;
  };
  const put = (row: ListItemRow) => {
    rows.set(row.id, row);
    owned.add(row.id);
    if (row.position > maxPos) maxPos = row.position;
  };
  const touch = (r: ListItemRow, m: Mutation, seq: number | null) => {
    r.updated_at = m.client_created_at;
    r.updated_by = input.userId;
    if (seq !== null) r.server_seq = Math.max(r.server_seq, seq);
  };
  const newRow = (m: Mutation & { kind: 'add_item' }, id: Uuid, position: number, seq: number): ListItemRow => ({
    id,
    household_id: m.household_id,
    name: m.payload.name.trim(),
    normalized_name: normalizeName(m.payload.name),
    quantity: roundQuantity(m.payload.quantity),
    unit: m.payload.unit,
    note: m.payload.note ?? '',
    checked: false,
    checked_at: null,
    position,
    exclude_from_comparison: false,
    created_by: input.userId,
    created_at: m.client_created_at,
    updated_by: input.userId,
    updated_at: m.client_created_at,
    deleted_at: null,
    deleted_by: null,
    server_seq: seq,
  });

  const findOpenDuplicate = (normalized: string, unit: string): ListItemRow | undefined => {
    let best: ListItemRow | undefined;
    for (const r of rows.values()) {
      if (r.deleted_at !== null || r.checked || r.normalized_name !== normalized || r.unit !== unit) continue;
      if (!best || r.position > best.position || (r.position === best.position && r.id > best.id)) best = r;
    }
    return best;
  };
  const findCheckedDuplicate = (normalized: string, unit: string): ListItemRow | undefined => {
    let best: ListItemRow | undefined;
    for (const r of rows.values()) {
      if (r.deleted_at !== null || !r.checked || r.normalized_name !== normalized || r.unit !== unit) continue;
      const a = r.checked_at ?? '';
      const b = best?.checked_at ?? '';
      if (!best || a > b || (a === b && r.position > best.position)) best = r;
    }
    return best;
  };

  for (const entry of input.entries) {
    const m = entry.mutation;
    const pending = entry.state === 'pending';
    const ackSeq = entry.state === 'acked' ? (entry.result?.server_seq ?? entry.ackedSeq ?? null) : null;
    const markPending = (id: Uuid | null) => {
      if (pending && id) pendingIds.add(id);
    };

    if (m.kind === 'add_item') {
      const p = m.payload;
      if (!pending && entry.result) {
        // Replay from the server's decision.
        const res = entry.result;
        const target = res.item_id ?? p.id;
        if (target !== p.id) aliases.set(p.id, target);
        const pos = res.server_seq ?? ackSeq ?? maxPos + 1;
        const existing = writable(target);
        if (res.status === 'merged') {
          if (existing) {
            if (existing.deleted_at === null) {
              existing.quantity = roundQuantity(existing.quantity + p.quantity);
              touch(existing, m, ackSeq);
            }
          } else put(newRow(m, target, pos, pos));
          sims.set(m.id, { outcome: 'merged', targetId: target });
        } else if (res.status === 'restored') {
          if (existing) {
            existing.checked = false;
            existing.checked_at = null;
            existing.quantity = roundQuantity(p.quantity);
            existing.position = pos;
            if (pos > maxPos) maxPos = pos;
            if (p.note) existing.note = p.note;
            touch(existing, m, ackSeq);
          } else put(newRow(m, target, pos, pos));
          sims.set(m.id, { outcome: 'restored', targetId: target, prevQuantity: entry.localMeta?.prevQuantity });
        } else {
          if (!existing) put(newRow(m, target, pos, pos));
          sims.set(m.id, { outcome: 'added', targetId: target });
        }
        continue;
      }
      // Pending: simulate the server's dedupe.
      if (rows.has(p.id) || aliases.has(p.id)) {
        sims.set(m.id, { outcome: 'noop', targetId: resolve(p.id) });
        continue;
      }
      const normalized = normalizeName(p.name);
      const open = findOpenDuplicate(normalized, p.unit);
      if (open) {
        const w = writable(open.id)!;
        w.quantity = roundQuantity(w.quantity + p.quantity);
        touch(w, m, null);
        aliases.set(p.id, w.id);
        markPending(w.id);
        sims.set(m.id, { outcome: 'merged', targetId: w.id });
        continue;
      }
      const checked = findCheckedDuplicate(normalized, p.unit);
      if (checked) {
        const w = writable(checked.id)!;
        const prev = w.quantity;
        w.checked = false;
        w.checked_at = null;
        w.quantity = roundQuantity(p.quantity);
        w.position = ++maxPos;
        if (p.note) w.note = p.note;
        touch(w, m, null);
        aliases.set(p.id, w.id);
        markPending(w.id);
        sims.set(m.id, { outcome: 'restored', targetId: w.id, prevQuantity: prev });
        continue;
      }
      put(newRow(m, p.id, maxPos + 1, 0));
      markPending(p.id);
      sims.set(m.id, { outcome: 'added', targetId: p.id });
      continue;
    }

    if (m.kind === 'clear_checked') {
      const ids = !pending && entry.result?.affected_ids ? entry.result.affected_ids : m.payload.item_ids;
      const affected: Uuid[] = [];
      for (const raw of ids) {
        const id = resolve(raw);
        const r = rows.get(id);
        if (!r || r.deleted_at !== null || (pending && !r.checked)) continue;
        const w = writable(id)!;
        w.deleted_at = m.client_created_at;
        w.deleted_by = input.userId;
        touch(w, m, ackSeq);
        affected.push(id);
        markPending(id);
      }
      sims.set(m.id, { outcome: affected.length ? 'updated' : 'noop', targetId: affected[0] ?? null, affectedIds: affected });
      continue;
    }

    // Single-target kinds.
    const rawTarget = (!pending && entry.result?.item_id) || m.payload.item_id;
    const id = resolve(rawTarget);
    const r = rows.get(id);
    if (!r) {
      sims.set(m.id, { outcome: 'noop', targetId: null, wouldReject: 'not_found' });
      continue;
    }
    switch (m.kind) {
      case 'update_item': {
        if (r.deleted_at !== null) {
          sims.set(m.id, { outcome: 'noop', targetId: id, wouldReject: 'deleted' });
          break;
        }
        const f = m.payload.fields;
        if (f.quantity !== undefined && !isValidQuantity(roundQuantity(f.quantity))) {
          sims.set(m.id, { outcome: 'noop', targetId: id, wouldReject: 'invalid' });
          break;
        }
        const w = writable(id)!;
        if (f.name !== undefined) {
          w.name = f.name.trim();
          w.normalized_name = normalizeName(f.name);
        }
        if (f.quantity !== undefined) w.quantity = roundQuantity(f.quantity);
        if (f.unit !== undefined) w.unit = f.unit;
        if (f.note !== undefined) w.note = f.note;
        if (f.exclude_from_comparison !== undefined) w.exclude_from_comparison = f.exclude_from_comparison;
        touch(w, m, ackSeq);
        markPending(id);
        sims.set(m.id, { outcome: 'updated', targetId: id });
        break;
      }
      case 'increment_quantity': {
        if (r.deleted_at !== null) {
          sims.set(m.id, { outcome: 'noop', targetId: id, wouldReject: 'deleted' });
          break;
        }
        const next = roundQuantity(r.quantity + m.payload.delta);
        if (!isValidQuantity(next)) {
          sims.set(m.id, { outcome: 'noop', targetId: id, wouldReject: 'invalid' });
          break;
        }
        const w = writable(id)!;
        w.quantity = next;
        touch(w, m, ackSeq);
        markPending(id);
        sims.set(m.id, { outcome: 'updated', targetId: id });
        break;
      }
      case 'set_checked': {
        if (r.deleted_at !== null) {
          sims.set(m.id, { outcome: 'noop', targetId: id, wouldReject: 'deleted' });
          break;
        }
        if (r.checked === m.payload.checked) {
          sims.set(m.id, { outcome: 'noop', targetId: id });
          break;
        }
        const w = writable(id)!;
        w.checked = m.payload.checked;
        w.checked_at = m.payload.checked ? m.client_created_at : null;
        touch(w, m, ackSeq);
        markPending(id);
        sims.set(m.id, { outcome: 'updated', targetId: id });
        break;
      }
      case 'delete_item': {
        if (r.deleted_at !== null) {
          sims.set(m.id, { outcome: 'noop', targetId: id });
          break;
        }
        const w = writable(id)!;
        w.deleted_at = m.client_created_at;
        w.deleted_by = input.userId;
        touch(w, m, ackSeq);
        markPending(id);
        sims.set(m.id, { outcome: 'updated', targetId: id });
        break;
      }
      case 'restore_item': {
        if (r.deleted_at === null) {
          sims.set(m.id, { outcome: 'noop', targetId: id });
          break;
        }
        const w = writable(id)!;
        w.deleted_at = null;
        w.deleted_by = null;
        touch(w, m, ackSeq);
        markPending(id);
        sims.set(m.id, { outcome: 'updated', targetId: id });
        break;
      }
    }
  }

  const items = new Map<Uuid, VisibleItem>();
  for (const [id, row] of rows) items.set(id, { ...row, pending: pendingIds.has(id) });
  return { items, sims, aliases };
}

/** Splits visible items into the two lists of ListSnapshot with the contract's sort orders. */
export function toLists(items: Iterable<VisibleItem>): { open: VisibleItem[]; checked: VisibleItem[] } {
  const open: VisibleItem[] = [];
  const checked: VisibleItem[] = [];
  for (const it of items) {
    if (it.deleted_at !== null) continue;
    (it.checked ? checked : open).push(it);
  }
  open.sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  checked.sort((a, b) => {
    const x = a.checked_at ?? '';
    const y = b.checked_at ?? '';
    if (x !== y) return x < y ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return { open, checked };
}

const ITEM_KEYS: (keyof VisibleItem)[] = [
  'id', 'household_id', 'name', 'normalized_name', 'quantity', 'unit', 'note', 'checked', 'checked_at',
  'position', 'exclude_from_comparison', 'created_by', 'created_at', 'updated_by', 'updated_at',
  'deleted_at', 'deleted_by', 'server_seq', 'pending',
];

export function sameItems(a: readonly VisibleItem[], b: readonly VisibleItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    for (const k of ITEM_KEYS) if (x[k] !== y[k]) return false;
  }
  return true;
}
