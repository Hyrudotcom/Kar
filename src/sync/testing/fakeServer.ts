/**
 * In-memory implementation of the server contract (docs/architecture.md 4.1 / 4.2), written
 * independently from the client reducer so tests catch disagreements between the two.
 * Also usable by mobile for the web preview without a backend (no prices, no network).
 *
 * Semantics: writes of one household are serialized (JS is single-threaded and apply() is sync),
 * server_seq is per household, idempotency log keyed by mutation id, aliases for merged adds,
 * tombstones with purge horizon, RLS-like membership checks.
 */
import {
  AuthRequiredError,
  LIMITS,
  TransientSyncError,
  UNITS,
  type ApplyMutationsRequest,
  type ApplyMutationsResponse,
  type HouseholdRow,
  type ListItemRow,
  type Mutation,
  type MutationResult,
  type PullChangesResponse,
  type SyncTransport,
  type Uuid,
} from '@/src/contracts';
import { normalizeName } from '@/src/shared/normalize';

interface ServerHousehold {
  id: Uuid;
  name: string;
  created_at: string;
  last_seq: number;
  purged_before_seq: number;
  members: Set<Uuid>;
}

interface LoggedMutation {
  household_id: Uuid;
  user_id: Uuid;
  kind: string;
  result: MutationResult;
}

type Nudge = (source: 'items' | 'household' | 'membership') => void;

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const validQty = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && round3(n) > 0 && round3(n) <= LIMITS.quantityMax;
const isUuidLike = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{8,64}$/i.test(s);

class Invalid extends Error {}

let fallbackCounter = 0;
function defaultUuid(): Uuid {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  fallbackCounter++;
  return `00000000-0000-4000-8000-${fallbackCounter.toString(16).padStart(12, '0')}`;
}

export class FakeServer {
  readonly households = new Map<Uuid, ServerHousehold>();
  readonly items = new Map<Uuid, ListItemRow>();
  readonly log = new Map<Uuid, LoggedMutation>();
  readonly aliases = new Map<Uuid, { household_id: Uuid; target_id: Uuid }>();
  /** Count of apply_mutations calls per mutation id (to assert duplicate delivery). */
  readonly deliveries = new Map<Uuid, number>();
  private householdNudges = new Map<Uuid, Set<Nudge>>();
  private userNudges = new Map<Uuid, Set<Nudge>>();
  /** Mutation ids for which the server answers status 'retry' (transient per-mutation failure). */
  readonly retryIds = new Set<Uuid>();
  private t: number;

  constructor(opts: { now?: () => number; uuid?: () => Uuid } = {}) {
    this.t = Date.UTC(2026, 9, 23, 8, 0, 0);
    this.nowFn = opts.now ?? (() => this.t++);
    this.uuid = opts.uuid ?? defaultUuid;
  }
  private nowFn: () => number;
  private uuid: () => Uuid;

  private nowIso(): string {
    return new Date(this.nowFn()).toISOString();
  }

  // --- household admin (test setup) ---------------------------------------------------------

  createHousehold(ownerId: Uuid, name = 'Thuis'): Uuid {
    const id = this.uuid();
    this.households.set(id, { id, name, created_at: this.nowIso(), last_seq: 0, purged_before_seq: 0, members: new Set([ownerId]) });
    return id;
  }

  addMember(householdId: Uuid, userId: Uuid): void {
    this.hh(householdId).members.add(userId);
    this.notify(householdId, 'membership');
  }

  removeMember(householdId: Uuid, userId: Uuid): void {
    this.hh(householdId).members.delete(userId);
    this.notify(householdId, 'membership');
    for (const n of [...(this.userNudges.get(userId) ?? [])]) n('membership');
  }

  rename(householdId: Uuid, name: string): void {
    this.hh(householdId).name = name;
    this.notify(householdId, 'household');
  }

  /** private.purge: drop tombstones (all, or deleted before `beforeIso`) and move the purge horizon. */
  purgeTombstones(householdId: Uuid, beforeIso?: string): number {
    const h = this.hh(householdId);
    let n = 0;
    for (const [id, it] of this.items) {
      if (it.household_id !== householdId || it.deleted_at === null) continue;
      if (beforeIso && it.deleted_at >= beforeIso) continue;
      this.items.delete(id);
      h.purged_before_seq = Math.max(h.purged_before_seq, it.server_seq); // backend: highest purged seq
      n++;
    }
    return n;
  }

  /** Visible server list (open first by position desc, then checked), for assertions. */
  list(householdId: Uuid): ListItemRow[] {
    return [...this.items.values()]
      .filter((i) => i.household_id === householdId && i.deleted_at === null)
      .sort((a, b) => Number(a.checked) - Number(b.checked) || b.position - a.position);
  }

  item(id: Uuid): ListItemRow | undefined {
    const it = this.items.get(id);
    return it ? { ...it } : undefined;
  }

  subscribeHousehold(householdId: Uuid, userId: Uuid, nudge: Nudge): () => void {
    if (!this.households.get(householdId)?.members.has(userId)) return () => undefined; // RLS: no events
    const set = this.householdNudges.get(householdId) ?? new Set();
    set.add(nudge);
    this.householdNudges.set(householdId, set);
    const uset = this.userNudges.get(userId) ?? new Set();
    uset.add(nudge);
    this.userNudges.set(userId, uset);
    return () => {
      set.delete(nudge);
      uset.delete(nudge);
    };
  }

  private notify(householdId: Uuid, source: 'items' | 'household' | 'membership') {
    for (const n of [...(this.householdNudges.get(householdId) ?? [])]) n(source);
  }

  private hh(id: Uuid): ServerHousehold {
    const h = this.households.get(id);
    if (!h) throw new Error(`no household ${id}`);
    return h;
  }

  // --- RPCs ------------------------------------------------------------------------------------

  applyMutations(userId: Uuid | null, req: ApplyMutationsRequest): ApplyMutationsResponse {
    if (!userId) return { ok: false, error: 'not_authenticated' };
    if (!req || typeof req !== 'object' || !Array.isArray(req.mutations) || req.mutations.length < 1 || req.mutations.length > LIMITS.mutationsPerBatch) {
      return { ok: false, error: 'invalid_batch' };
    }
    for (const m of req.mutations) {
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.kind !== 'string') return { ok: false, error: 'invalid_batch' };
    }
    const h = this.households.get(req.household_id);
    if (!h || !h.members.has(userId)) return { ok: false, error: 'not_member' };

    const results: MutationResult[] = [];
    let changed = false;
    // Like apply_mutations: after the first 'retry' nothing new is applied in this batch, so a later
    // mutation can never overtake an earlier one (e.g. an add merging into a row a delete removes).
    let stopped = false;
    for (const m of req.mutations) {
      this.deliveries.set(m.id, (this.deliveries.get(m.id) ?? 0) + 1);
      const logged = this.log.get(m.id);
      if (logged) {
        // Like apply_mutations (round 3): a log entry of another household (the user switched) is
        // reported as done here, never with the other household's item id or server_seq.
        results.push(
          logged.user_id !== userId
            ? { id: m.id, status: 'rejected', reason: 'invalid' }
            : logged.household_id === h.id
              ? { ...logged.result, replayed: true }
              : { id: m.id, status: 'applied', replayed: true },
        );
        continue;
      }
      if (stopped || this.retryIds.has(m.id)) {
        stopped = true;
        results.push({ id: m.id, status: 'retry' });
        continue;
      }
      let result: MutationResult;
      if (m.household_id !== h.id) {
        result = { id: m.id, status: 'rejected', reason: 'forbidden' };
      } else {
        // Subtransaction: snapshot touched state so a validation error leaves nothing behind.
        const seqBefore = h.last_seq;
        const backup = new Map<Uuid, ListItemRow | undefined>();
        const aliasBackup = new Map<Uuid, { household_id: Uuid; target_id: Uuid } | undefined>();
        try {
          result = this.applyOne(h, userId, m, backup, aliasBackup);
        } catch (e) {
          h.last_seq = seqBefore;
          for (const [id, row] of backup) {
            if (row) this.items.set(id, row);
            else this.items.delete(id);
          }
          for (const [id, a] of aliasBackup) {
            if (a) this.aliases.set(id, a);
            else this.aliases.delete(id);
          }
          result = e instanceof Invalid ? { id: m.id, status: 'rejected', reason: 'invalid' } : { id: m.id, status: 'retry' };
        }
        if (h.last_seq !== seqBefore) changed = true;
      }
      if (result.status !== 'retry') this.log.set(m.id, { household_id: h.id, user_id: userId, kind: m.kind, result });
      else stopped = true;
      results.push(result);
    }
    if (changed) this.notify(h.id, 'items');
    return { ok: true, results, server_seq: h.last_seq };
  }

  pullChanges(userId: Uuid | null, householdId: Uuid, sinceSeq: number, limit: number = LIMITS.pullPageSize): PullChangesResponse {
    if (!userId) return { ok: false, error: 'not_authenticated' };
    const h = this.households.get(householdId);
    if (!h || !h.members.has(userId)) return { ok: false, error: 'not_member' };
    const vLast = h.last_seq;
    const household: HouseholdRow = { id: h.id, name: h.name, created_at: h.created_at, last_seq: h.last_seq };
    if (sinceSeq > 0 && (sinceSeq < h.purged_before_seq || sinceSeq > vLast)) {
      return { ok: true, household, items: [], server_seq: 0, has_more: false, reset_required: true };
    }
    const rows = [...this.items.values()]
      .filter((i) => i.household_id === householdId && i.server_seq > sinceSeq && i.server_seq <= vLast && (sinceSeq > 0 || i.deleted_at === null))
      .sort((a, b) => a.server_seq - b.server_seq);
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return {
      ok: true,
      household,
      items: page.map((r) => ({ ...r })),
      server_seq: hasMore ? page[page.length - 1]!.server_seq : vLast,
      has_more: hasMore,
      reset_required: false,
    };
  }

  // --- per-kind rules ------------------------------------------------------------------------

  private applyOne(
    h: ServerHousehold,
    userId: Uuid,
    m: Mutation,
    backup: Map<Uuid, ListItemRow | undefined>,
    aliasBackup: Map<Uuid, { household_id: Uuid; target_id: Uuid } | undefined>,
  ): MutationResult {
    const p = (m.payload ?? {}) as unknown as Record<string, unknown>;
    const save = (id: Uuid) => {
      if (!backup.has(id)) backup.set(id, this.items.get(id) ? { ...this.items.get(id)! } : undefined);
    };
    const bump = (row: ListItemRow) => {
      h.last_seq += 1;
      row.server_seq = h.last_seq;
      row.updated_at = this.nowIso();
      row.updated_by = userId;
      return h.last_seq;
    };
    const resolve = (raw: unknown): Uuid => {
      if (!isUuidLike(raw)) throw new Invalid('bad id');
      const a = this.aliases.get(raw);
      return a && a.household_id === h.id ? a.target_id : raw;
    };
    const target = (raw: unknown): { row?: ListItemRow; id: Uuid } => {
      const id = resolve(raw);
      const row = this.items.get(id);
      if (!row || row.household_id !== h.id) return { id };
      save(id);
      return { row, id };
    };

    switch (m.kind) {
      case 'add_item': {
        const id = p.id;
        if (!isUuidLike(id)) throw new Invalid('id');
        const name = typeof p.name === 'string' ? p.name.trim() : '';
        if (name.length < 1 || name.length > LIMITS.nameMaxLength) throw new Invalid('name');
        if (!validQty(p.quantity)) throw new Invalid('quantity');
        if (!(UNITS as readonly unknown[]).includes(p.unit)) throw new Invalid('unit');
        const note = p.note === undefined || p.note === null ? '' : p.note;
        if (typeof note !== 'string' || note.length > LIMITS.noteMaxLength) throw new Invalid('note');
        const qty = round3(p.quantity as number);
        const unit = p.unit as ListItemRow['unit'];
        const existing = this.items.get(id);
        if (existing && existing.household_id !== h.id) throw new Invalid('id exists elsewhere');
        if (existing) return { id: m.id, status: 'applied', item_id: id };
        const alias = this.aliases.get(id);
        if (alias) {
          if (alias.household_id !== h.id) throw new Invalid('alias elsewhere');
          return { id: m.id, status: 'applied', item_id: alias.target_id };
        }
        const nn = normalizeName(name);
        const mine = [...this.items.values()].filter((r) => r.household_id === h.id && r.deleted_at === null && r.normalized_name === nn && r.unit === unit);
        const open = mine.filter((r) => !r.checked).sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : 1))[0];
        const setAlias = (targetId: Uuid) => {
          if (!aliasBackup.has(id)) aliasBackup.set(id, this.aliases.get(id));
          this.aliases.set(id, { household_id: h.id, target_id: targetId });
        };
        if (open) {
          save(open.id);
          const next = round3(open.quantity + qty);
          if (next > LIMITS.quantityMax) throw new Invalid('quantity overflow');
          open.quantity = next;
          const seq = bump(open);
          setAlias(open.id);
          return { id: m.id, status: 'merged', item_id: open.id, server_seq: seq };
        }
        const checked = mine
          .filter((r) => r.checked)
          .sort((a, b) => ((b.checked_at ?? '') > (a.checked_at ?? '') ? 1 : (b.checked_at ?? '') < (a.checked_at ?? '') ? -1 : b.position - a.position))[0];
        if (checked) {
          save(checked.id);
          checked.checked = false;
          checked.checked_at = null;
          checked.quantity = qty;
          if (note) checked.note = note;
          const seq = bump(checked);
          checked.position = seq;
          setAlias(checked.id);
          return { id: m.id, status: 'restored', item_id: checked.id, server_seq: seq };
        }
        save(id);
        const now = this.nowIso();
        const row: ListItemRow = {
          id,
          household_id: h.id,
          name,
          normalized_name: nn,
          quantity: qty,
          unit,
          note,
          checked: false,
          checked_at: null,
          position: 0,
          exclude_from_comparison: false,
          created_by: userId,
          created_at: now,
          updated_by: userId,
          updated_at: now,
          deleted_at: null,
          deleted_by: null,
          server_seq: 0,
        };
        this.items.set(id, row);
        const seq = bump(row);
        row.position = seq;
        return { id: m.id, status: 'applied', item_id: id, server_seq: seq };
      }
      case 'update_item': {
        const { row, id } = target(p.item_id);
        const f = (p.fields ?? {}) as Record<string, unknown>;
        if (typeof f !== 'object') throw new Invalid('fields');
        if (f.name !== undefined && (typeof f.name !== 'string' || f.name.trim().length < 1 || f.name.trim().length > LIMITS.nameMaxLength)) throw new Invalid('name');
        if (f.quantity !== undefined && !validQty(f.quantity)) throw new Invalid('quantity');
        if (f.unit !== undefined && !(UNITS as readonly unknown[]).includes(f.unit)) throw new Invalid('unit');
        if (f.note !== undefined && (typeof f.note !== 'string' || f.note.length > LIMITS.noteMaxLength)) throw new Invalid('note');
        if (f.exclude_from_comparison !== undefined && typeof f.exclude_from_comparison !== 'boolean') throw new Invalid('exclude');
        if (!row) return { id: m.id, status: 'rejected', reason: 'not_found' };
        if (row.deleted_at !== null) return { id: m.id, status: 'rejected', reason: 'deleted', item_id: id };
        let dirty = false;
        if (typeof f.name === 'string' && f.name.trim() !== row.name) {
          row.name = f.name.trim();
          row.normalized_name = normalizeName(row.name);
          dirty = true;
        }
        if (typeof f.quantity === 'number' && round3(f.quantity) !== row.quantity) {
          row.quantity = round3(f.quantity);
          dirty = true;
        }
        if (f.unit !== undefined && f.unit !== row.unit) {
          row.unit = f.unit as ListItemRow['unit'];
          dirty = true;
        }
        if (typeof f.note === 'string' && f.note !== row.note) {
          row.note = f.note;
          dirty = true;
        }
        if (typeof f.exclude_from_comparison === 'boolean' && f.exclude_from_comparison !== row.exclude_from_comparison) {
          row.exclude_from_comparison = f.exclude_from_comparison;
          dirty = true;
        }
        return { id: m.id, status: 'applied', item_id: id, ...(dirty ? { server_seq: bump(row) } : {}) };
      }
      case 'increment_quantity': {
        const { row, id } = target(p.item_id);
        if (typeof p.delta !== 'number' || !Number.isFinite(p.delta)) throw new Invalid('delta');
        if (!row) return { id: m.id, status: 'rejected', reason: 'not_found' };
        if (row.deleted_at !== null) return { id: m.id, status: 'rejected', reason: 'deleted', item_id: id };
        const next = round3(row.quantity + p.delta);
        if (!(next > 0 && next <= LIMITS.quantityMax)) throw new Invalid('quantity');
        row.quantity = next;
        return { id: m.id, status: 'applied', item_id: id, server_seq: bump(row) };
      }
      case 'set_checked': {
        const { row, id } = target(p.item_id);
        if (typeof p.checked !== 'boolean') throw new Invalid('checked');
        if (!row) return { id: m.id, status: 'rejected', reason: 'not_found' };
        if (row.deleted_at !== null) return { id: m.id, status: 'rejected', reason: 'deleted', item_id: id };
        if (row.checked === p.checked) return { id: m.id, status: 'applied', item_id: id };
        row.checked = p.checked;
        row.checked_at = p.checked ? this.nowIso() : null;
        return { id: m.id, status: 'applied', item_id: id, server_seq: bump(row) };
      }
      case 'delete_item': {
        const { row, id } = target(p.item_id);
        if (!row) return { id: m.id, status: 'rejected', reason: 'not_found' };
        if (row.deleted_at !== null) return { id: m.id, status: 'applied', item_id: id };
        row.deleted_at = this.nowIso();
        row.deleted_by = userId;
        return { id: m.id, status: 'applied', item_id: id, server_seq: bump(row) };
      }
      case 'restore_item': {
        const { row, id } = target(p.item_id);
        if (!row) return { id: m.id, status: 'rejected', reason: 'not_found' };
        if (row.deleted_at === null) return { id: m.id, status: 'applied', item_id: id };
        row.deleted_at = null;
        row.deleted_by = null;
        return { id: m.id, status: 'applied', item_id: id, server_seq: bump(row) };
      }
      case 'clear_checked': {
        if (!Array.isArray(p.item_ids)) throw new Invalid('item_ids');
        const affected: Uuid[] = [];
        let seq: number | undefined;
        for (const raw of p.item_ids) {
          const { row, id } = target(raw);
          if (!row || row.deleted_at !== null || !row.checked || affected.includes(id)) continue;
          row.deleted_at = this.nowIso();
          row.deleted_by = userId;
          seq = bump(row);
          affected.push(id);
        }
        return { id: m.id, status: 'applied', affected_ids: affected, ...(seq !== undefined ? { server_seq: seq } : {}) };
      }
      default:
        throw new Invalid('unknown kind');
    }
  }
}

export interface FakeTransportOptions {
  online?: boolean;
}

/**
 * One device's connection to the FakeServer. Failure injection:
 *  - online=false            -> TransientSyncError (like a network failure)
 *  - sessionExpired=true     -> AuthRequiredError
 *  - loseNextResponses(n)    -> the server applies the batch, but the response never arrives
 *  - hold()                  -> requests wait until release() (to test races with in-flight batches)
 *  - failNext(n)             -> HTTP 5xx before reaching the server
 */
export class FakeTransport implements SyncTransport {
  online: boolean;
  sessionExpired = false;
  readonly calls: { fn: 'apply' | 'pull'; req: unknown }[] = [];
  private lose = 0;
  private fail = 0;
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  constructor(
    readonly server: FakeServer,
    readonly userId: Uuid,
    opts: FakeTransportOptions = {},
  ) {
    this.online = opts.online ?? true;
  }

  loseNextResponses(n = 1): void {
    this.lose += n;
  }

  failNext(n = 1): void {
    this.fail += n;
  }

  /** Network healthy again: drops pending injected failures. */
  heal(): void {
    this.online = true;
    this.lose = 0;
    this.fail = 0;
  }

  hold(): void {
    if (this.gate) return;
    this.gate = new Promise((r) => (this.openGate = r));
  }

  release(): void {
    this.openGate?.();
    this.gate = null;
    this.openGate = null;
  }

  private async preflight(): Promise<void> {
    await Promise.resolve();
    if (this.gate) await this.gate;
    if (!this.online) throw new TransientSyncError('network unreachable');
    if (this.sessionExpired) throw new AuthRequiredError('JWT expired');
    if (this.fail > 0) {
      this.fail--;
      throw new TransientSyncError('HTTP 503');
    }
  }

  async applyMutations(req: ApplyMutationsRequest): Promise<ApplyMutationsResponse> {
    this.calls.push({ fn: 'apply', req: JSON.parse(JSON.stringify(req)) });
    await this.preflight();
    const res = this.server.applyMutations(this.userId, JSON.parse(JSON.stringify(req)));
    if (this.lose > 0) {
      this.lose--;
      throw new TransientSyncError('connection reset after request was sent');
    }
    return JSON.parse(JSON.stringify(res));
  }

  async pullChanges(householdId: Uuid, sinceSeq: number, limit?: number): Promise<PullChangesResponse> {
    this.calls.push({ fn: 'pull', req: { householdId, sinceSeq, limit } });
    await this.preflight();
    return JSON.parse(JSON.stringify(this.server.pullChanges(this.userId, householdId, sinceSeq, limit)));
  }

  subscribe(householdId: Uuid, onNudge: Nudge): () => void {
    return this.server.subscribeHousehold(householdId, this.userId, (s) => {
      if (this.online) onNudge(s);
    });
  }

  applyCount(): number {
    return this.calls.filter((c) => c.fn === 'apply').length;
  }
}
