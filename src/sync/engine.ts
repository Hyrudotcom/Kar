/**
 * Offline-first sync engine (docs/architecture.md section 5, design-spec section 5).
 *
 * Invariants:
 *  - Every command writes its mutation to the SQLite outbox (in a transaction) before the visible
 *    snapshot changes. A crash after the write loses nothing; a crash before it loses the tap only.
 *  - Visible = reduce(server_items, outbox). Acked rows are replayed until a pull covers acked_seq.
 *  - The server decides all conflicts (dedupe, delete wins, increments, per-field LWW). The client
 *    never uses its clock for conflict resolution.
 *  - Mutation ids are idempotency keys: a batch whose response was lost is re-sent with the same ids.
 *  - All database access goes through one mutex, so commands, acks and pulls never interleave.
 */
import {
  AuthRequiredError,
  LIMITS,
  type AddItemInput,
  type ApplyMutationsResponse,
  type Clock,
  type CommandResult,
  type FailedMutation,
  type HistoryEntry,
  type HouseholdRow,
  type ListItemRow,
  type ListSnapshot,
  type Mutation,
  type MutationKind,
  type MutationPayloads,
  type MutationResult,
  type PullChangesResponse,
  type SyncEngineDeps,
  type SyncStatus,
  type UndoAction,
  type Unit,
  type Uuid,
  type VisibleItem,
} from '@/src/contracts';
import { normalizeName } from '@/src/shared/normalize';
import { failedAsText as formatFailed } from './failedText';
import { reduce, sameItems, toLists, type ReduceOutput, type SimResult } from './reducer';
import { LocalStore } from './store';
import type { GoedSyncEngine, LocalMeta, OutboxEntry, PriceCacheEntry } from './types';
import { BACKOFF_MAX_MS, Mutex, backoffDelay, systemClock } from './util';
import { cleanDelta, cleanName, cleanNote, cleanQuantity, cleanUnit, roundQuantity } from './validate';

export interface SyncEngineOptions {
  /** Debounce between a command and the push (ms). Default 150. */
  pushDebounceMs?: number;
  /** Debounce for realtime nudges (ms). Default 100. */
  nudgeDebounceMs?: number;
  /** Safety-net pull interval while the app is active (ms). Default 60 000. */
  periodicPullMs?: number;
  /** pull_changes page size. Default LIMITS.pullPageSize (500). */
  pullPageSize?: number;
  /** Max mutations per apply_mutations call. Default LIMITS.mutationsPerBatch (100). */
  batchSize?: number;
  /** Randomness for backoff jitter (tests). */
  random?: () => number;
  /** Called for unexpected internal errors (logging). */
  onError?: (error: unknown, context: string) => void;
}

const DAY = 86_400_000;
const ACK_LOG_RETENTION_MS = DAY;
const TOMBSTONE_RETENTION_MS = 30 * DAY;

type FieldsInput = Parameters<GoedSyncEngine['updateItem']>[1];

const EMPTY_LISTS = { open: [] as VisibleItem[], checked: [] as VisibleItem[] };

/** Item ids a mutation reads or writes (payload ids, before alias resolution). */
export function mutationTargets(m: Mutation): Uuid[] {
  switch (m.kind) {
    case 'add_item':
      return [m.payload.id];
    case 'clear_checked':
      return [...m.payload.item_ids];
    default:
      return [m.payload.item_id];
  }
}

/**
 * Send and simulation order of the outbox: by seq, except inverse rows of an undone add/clear
 * (LocalMeta.orderAfter), which go right after the row they undo.
 */
export function byOutboxOrder(a: OutboxEntry, b: OutboxEntry): number {
  const ka = a.localMeta?.orderAfter ?? a.seq;
  const kb = b.localMeta?.orderAfter ?? b.seq;
  if (ka !== kb) return ka - kb;
  const sa = a.localMeta?.orderAfter !== undefined ? 1 : 0;
  const sb = b.localMeta?.orderAfter !== undefined ? 1 : 0;
  return sa - sb || a.seq - b.seq;
}

export function createSyncEngine(deps: SyncEngineDeps, options: SyncEngineOptions = {}): GoedSyncEngine {
  return new Engine(deps, options);
}

class Engine implements GoedSyncEngine {
  private readonly store: LocalStore;
  private readonly clock: Clock;
  private readonly opts: Required<Omit<SyncEngineOptions, 'onError'>> & Pick<SyncEngineOptions, 'onError'>;
  private readonly lock = new Mutex();

  // Persistent state mirrored in memory (always updated after the DB write committed).
  private items = new Map<Uuid, ListItemRow>();
  private outbox: OutboxEntry[] = [];
  private failed: FailedMutation[] = [];
  private aliases = new Map<Uuid, Uuid>();
  private lastSeq = 0;
  private household: HouseholdRow | null = null;

  private reduced: ReduceOutput = { items: new Map(), sims: new Map(), aliases: new Map() };
  private snapshot: ListSnapshot;
  private status: SyncStatus;
  private listeners = new Set<(s: ListSnapshot) => void>();
  private statusListeners = new Set<(s: SyncStatus) => void>();
  private membershipListeners = new Set<() => void>();

  private readyResolve!: () => void;
  private readyReject!: (e: unknown) => void;
  private readonly ready: Promise<void>;
  private started = false;
  private stopped = false;
  private membershipLost = false;
  private needsReauth = false;
  private appActive = true;

  private loop: Promise<void> | null = null;
  private rerun = false;
  private forceNext = false;
  /** syncNow(): the next cycle also sends rows that wait for their per-row backoff. */
  private retryNow = false;
  private inFlight = new Set<Uuid>();
  private transportFailures = 0;
  private backoffUntil = 0;
  private timers = { push: null as unknown, retry: null as unknown, periodic: null as unknown };
  private pushTimerAt = Infinity;
  private retryTimerAt = Infinity;
  private unsubs: (() => void)[] = [];

  constructor(
    private readonly deps: SyncEngineDeps,
    options: SyncEngineOptions,
  ) {
    this.store = new LocalStore(deps.db);
    this.clock = deps.clock ?? systemClock;
    this.opts = {
      pushDebounceMs: options.pushDebounceMs ?? 150,
      nudgeDebounceMs: options.nudgeDebounceMs ?? 100,
      periodicPullMs: options.periodicPullMs ?? 60_000,
      pullPageSize: options.pullPageSize ?? LIMITS.pullPageSize,
      batchSize: Math.min(options.batchSize ?? LIMITS.mutationsPerBatch, LIMITS.mutationsPerBatch),
      random: options.random ?? Math.random,
      onError: options.onError,
    };
    this.snapshot = { householdId: deps.householdId, open: [], checked: [], revision: 0, loaded: false };
    this.status = { icon: 'idle', pendingCount: 0, failed: [], needsReauth: false, lastPulledSeq: 0 };
    this.ready = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    this.ready.catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return this.ready;
    this.started = true;
    try {
      await this.lock.run(async () => {
        await this.store.init();
        let s = await this.store.load();
        if (s.userId && s.userId !== this.deps.userId) {
          throw new Error('Local database belongs to another user; destroy it before opening.');
        }
        await this.deps.db.transaction(async () => {
          if (s.householdId !== this.deps.householdId) {
            if (s.householdId !== null) {
              // The user's solo household was merged into this one (accept_invite; the session opens
              // a file on another household only then, see merged_from). The server moved/merged the
              // open items and keeps aliases, so pending mutations are re-addressed to it.
              await this.store.clearItems();
              await this.store.deleteAllAcked();
              await this.store.clearAliases();
              await this.store.clearPriceCache();
              await this.store.setOutboxHousehold(this.deps.householdId);
              await this.store.setMeta('last_seq', '0');
              await this.deps.db.run("delete from meta where key = 'household'");
            }
            await this.store.setMeta('household_id', this.deps.householdId);
          }
          if (!s.userId) await this.store.setMeta('user_id', this.deps.userId);
          const now = this.clock.now();
          await this.store.pruneTombstones(new Date(now - TOMBSTONE_RETENTION_MS).toISOString());
          await this.store.pruneAckLog(now - ACK_LOG_RETENTION_MS);
        });
        s = await this.store.load();
        this.items = s.items;
        this.outbox = [...s.outbox].sort(byOutboxOrder);
        this.failed = s.failed;
        this.aliases = s.aliases;
        this.lastSeq = s.lastSeq;
        this.household = s.household;
      });
    } catch (e) {
      this.readyReject(e);
      throw e;
    }
    this.recompute(true);
    this.readyResolve();
    if (this.stopped) return;

    this.unsubs.push(
      this.deps.connectivity.subscribe((online) => {
        this.emitStatus();
        if (online) {
          this.transportFailures = 0;
          this.backoffUntil = 0;
          this.trigger();
        }
      }),
    );
    try {
      this.unsubs.push(
        this.deps.transport.subscribe(this.deps.householdId, () => this.schedulePush(this.opts.nudgeDebounceMs)),
      );
    } catch (e) {
      this.report(e, 'subscribe');
    }
    this.schedulePeriodic();
    this.trigger();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    for (const u of this.unsubs.splice(0)) {
      try {
        u();
      } catch (e) {
        this.report(e, 'unsubscribe');
      }
    }
    if (this.loop) await this.loop.catch(() => undefined);
    // Wait for queued DB work (commands) to drain before the caller closes/destroys the file.
    await this.lock.run(async () => undefined);
  }

  async dispose(): Promise<void> {
    await this.stop();
    await this.deps.db.close();
  }

  // -------------------------------------------------------------------------
  // Read side
  // -------------------------------------------------------------------------

  getSnapshot(): ListSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (s: ListSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribeStatus(listener: (s: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getHousehold(): HouseholdRow | null {
    return this.household;
  }

  onMembershipLost(listener: () => void): () => void {
    this.membershipListeners.add(listener);
    return () => {
      this.membershipListeners.delete(listener);
    };
  }

  failedAsText(): string {
    return formatFailed(this.failed);
  }

  resolveId(itemId: Uuid): Uuid {
    return this.resolve(itemId);
  }

  unsent(): { count: number; text: string } {
    const now = this.clock.now();
    const pending: FailedMutation[] = this.outbox
      .filter((e) => e.state === 'pending')
      .map((e) => ({ mutationId: e.mutation.id, kind: e.mutation.kind, itemName: this.itemNameFor(e.mutation), reason: 'not_member', failedAt: now }));
    const all = [...this.failed, ...pending];
    return { count: all.length, text: formatFailed(all) };
  }

  async readPriceCache(): Promise<PriceCacheEntry | null> {
    await this.ready;
    return this.lock.run(async () => {
      const r = await this.deps.db.get<{ result: string; list_fingerprint: string; computed_at: number }>(
        'select result, list_fingerprint, computed_at from price_cache where id = 1',
      );
      if (!r) return null;
      try {
        return { result: JSON.parse(r.result) as unknown, listFingerprint: r.list_fingerprint, computedAt: Number(r.computed_at) };
      } catch {
        return null;
      }
    });
  }

  async writePriceCache(entry: PriceCacheEntry): Promise<void> {
    await this.ready;
    await this.lock.run(async () => {
      await this.deps.db.run(
        `insert into price_cache (id, result, list_fingerprint, computed_at) values (1, ?, ?, ?)
         on conflict(id) do update set result = excluded.result, list_fingerprint = excluded.list_fingerprint, computed_at = excluded.computed_at`,
        [JSON.stringify(entry.result), entry.listFingerprint, entry.computedAt],
      );
    });
  }

  async getHistory(): Promise<HistoryEntry[]> {
    await this.ready;
    return this.lock.run(() => this.store.history(200));
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async addItem(input: AddItemInput): Promise<CommandResult> {
    const name = cleanName(input.name);
    const quantity = cleanQuantity(input.quantity);
    const unit = cleanUnit(input.unit);
    const note = cleanNote(input.note);
    const id = this.deps.uuid();
    const payload: MutationPayloads['add_item'] = { id, name, quantity, unit, ...(note ? { note } : {}) };
    return this.command(async () => {
      if (!this.accepting()) return noop(id, name);
      const m = this.mutation('add_item', payload);
      const { sim, out } = this.simulate(m);
      const meta: LocalMeta = { outcome: sim.outcome, targetId: sim.targetId ?? id, prevQuantity: sim.prevQuantity };
      await this.persist(m, meta, out, async () => {
        await this.store.bumpHistory(normalizeName(name), unit, name, this.clock.now());
      });
      const target = sim.targetId ?? id;
      return {
        itemId: target,
        outcome: sim.outcome === 'noop' ? 'added' : sim.outcome,
        undo: [{ kind: 'revert_add', mutationId: m.id }],
        itemName: out.items.get(target)?.name ?? name,
      };
    });
  }

  async updateItem(itemId: Uuid, fields: FieldsInput): Promise<CommandResult> {
    const clean: MutationPayloads['update_item']['fields'] = {};
    if (fields.name !== undefined) clean.name = cleanName(fields.name);
    if (fields.quantity !== undefined) clean.quantity = cleanQuantity(fields.quantity);
    if (fields.unit !== undefined) clean.unit = cleanUnit(fields.unit);
    if (fields.note !== undefined) clean.note = cleanNote(fields.note);
    if (fields.exclude_from_comparison !== undefined) clean.exclude_from_comparison = !!fields.exclude_from_comparison;
    return this.command(async () => {
      const cur = this.visible(itemId);
      if (!cur || cur.deleted_at !== null || !this.accepting()) return noop(itemId, cur?.name ?? '');
      const changed: MutationPayloads['update_item']['fields'] = {};
      const undoFields: Extract<UndoAction, { kind: 'update_item' }>['fields'] = {};
      if (clean.name !== undefined && clean.name !== cur.name) {
        changed.name = clean.name;
        undoFields.name = cur.name;
      }
      if (clean.quantity !== undefined && clean.quantity !== cur.quantity) {
        changed.quantity = clean.quantity;
        undoFields.quantity = cur.quantity;
      }
      if (clean.unit !== undefined && clean.unit !== cur.unit) {
        changed.unit = clean.unit;
        undoFields.unit = cur.unit;
      }
      if (clean.note !== undefined && clean.note !== cur.note) {
        changed.note = clean.note;
        undoFields.note = cur.note;
      }
      if (clean.exclude_from_comparison !== undefined && clean.exclude_from_comparison !== cur.exclude_from_comparison) {
        changed.exclude_from_comparison = clean.exclude_from_comparison;
      }
      if (Object.keys(changed).length === 0) return noop(cur.id, cur.name);
      const m = this.mutation('update_item', { item_id: cur.id, fields: changed });
      const { out } = this.simulate(m);
      await this.persist(m, { outcome: 'updated', targetId: cur.id }, out);
      const undo: UndoAction[] = Object.keys(undoFields).length ? [{ kind: 'update_item', itemId: cur.id, fields: undoFields }] : [];
      if (changed.exclude_from_comparison !== undefined) {
        undo.push({ kind: 'update_item', itemId: cur.id, fields: { exclude_from_comparison: cur.exclude_from_comparison } });
      }
      return { itemId: cur.id, outcome: 'updated', undo, itemName: out.items.get(cur.id)?.name ?? cur.name };
    });
  }

  async incrementQuantity(itemId: Uuid, delta: number): Promise<CommandResult> {
    const d = cleanDelta(delta);
    return this.command(async () => {
      const cur = this.visible(itemId);
      if (!cur || cur.deleted_at !== null || !this.accepting()) return noop(itemId, cur?.name ?? '');
      const m = this.mutation('increment_quantity', { item_id: cur.id, delta: d });
      const { sim, out } = this.simulate(m);
      if (sim.outcome === 'noop') return noop(cur.id, cur.name);
      await this.persist(m, { outcome: 'updated', targetId: cur.id }, out);
      return {
        itemId: cur.id,
        outcome: 'updated',
        undo: [{ kind: 'increment_quantity', itemId: cur.id, delta: -d }],
        itemName: cur.name,
      };
    });
  }

  async setChecked(itemId: Uuid, checked: boolean): Promise<CommandResult> {
    return this.command(async () => {
      const cur = this.visible(itemId);
      if (!cur || cur.deleted_at !== null || cur.checked === checked || !this.accepting()) return noop(itemId, cur?.name ?? '');
      const m = this.mutation('set_checked', { item_id: cur.id, checked });
      const { out } = this.simulate(m);
      await this.persist(m, { outcome: 'updated', targetId: cur.id }, out);
      return { itemId: cur.id, outcome: 'updated', undo: [{ kind: 'set_checked', itemId: cur.id, checked: !checked }], itemName: cur.name };
    });
  }

  async deleteItem(itemId: Uuid): Promise<CommandResult> {
    return this.command(async () => {
      const cur = this.visible(itemId);
      if (!cur || cur.deleted_at !== null || !this.accepting()) return noop(itemId, cur?.name ?? '');
      const m = this.mutation('delete_item', { item_id: cur.id });
      const { out } = this.simulate(m);
      await this.persist(m, { outcome: 'updated', targetId: cur.id }, out);
      return { itemId: cur.id, outcome: 'updated', undo: [{ kind: 'restore_item', itemId: cur.id }], itemName: cur.name };
    });
  }

  async restoreItem(itemId: Uuid): Promise<CommandResult> {
    return this.command(async () => {
      const cur = this.visible(itemId);
      if (!cur || cur.deleted_at === null || !this.accepting()) return noop(itemId, cur?.name ?? '');
      const m = this.mutation('restore_item', { item_id: cur.id });
      const { out } = this.simulate(m);
      await this.persist(m, { outcome: 'updated', targetId: cur.id }, out);
      return { itemId: cur.id, outcome: 'updated', undo: [{ kind: 'delete_item', itemId: cur.id }], itemName: cur.name };
    });
  }

  async clearChecked(itemIds: Uuid[]): Promise<CommandResult[]> {
    return this.command(async () => {
      if (!this.accepting()) return [];
      const ids = [...new Set(itemIds.map((i) => this.resolve(i)))];
      const onScreen = ids.filter((i) => {
        const r = this.reduced.items.get(i);
        return r && r.checked && r.deleted_at === null;
      });
      if (onScreen.length === 0) return [];
      const results: CommandResult[] = [];
      for (let i = 0; i < onScreen.length; i += 500) {
        const chunk = onScreen.slice(i, i + 500);
        const m = this.mutation('clear_checked', { item_ids: chunk });
        const { sim, out } = this.simulate(m);
        await this.persist(m, { outcome: 'updated' }, out);
        for (const id of sim.affectedIds ?? []) {
          results.push({ itemId: id, outcome: 'updated', undo: [{ kind: 'restore_item', itemId: id, clearMutationId: m.id }], itemName: out.items.get(id)?.name ?? '' });
        }
      }
      return results;
    });
  }

  async undo(actions: UndoAction[]): Promise<void> {
    for (const a of actions) {
      switch (a.kind) {
        case 'revert_add':
          await this.revertAdd(a.mutationId);
          break;
        case 'restore_item': {
          if (a.clearMutationId) {
            if (await this.revertClear(a.clearMutationId, a.itemId)) await this.restoreItem(a.itemId);
          } else await this.restoreItem(a.itemId);
          break;
        }
        case 'delete_item':
          await this.deleteItem(a.itemId);
          break;
        case 'set_checked':
          await this.setChecked(a.itemId, a.checked);
          break;
        case 'increment_quantity':
          await this.incrementQuantity(a.itemId, a.delta);
          break;
        case 'update_item':
          await this.updateItem(a.itemId, a.fields);
          break;
      }
    }
  }

  async discardFailed(mutationIds: Uuid[]): Promise<void> {
    await this.ready;
    await this.lock.run(async () => {
      await this.store.deleteFailed(mutationIds);
      const drop = new Set(mutationIds);
      this.failed = this.failed.filter((f) => !drop.has(f.mutationId));
    });
    this.emitStatus();
  }

  // -------------------------------------------------------------------------
  // Sync triggers
  // -------------------------------------------------------------------------

  async syncNow(): Promise<void> {
    try {
      await this.ready;
    } catch {
      return;
    }
    this.forceNext = true;
    this.retryNow = true;
    await this.trigger();
    await this.whenIdle();
  }

  notifyReauthenticated(): void {
    this.needsReauth = false;
    this.transportFailures = 0;
    this.backoffUntil = 0;
    this.emitStatus();
    this.trigger();
  }

  setAppActive(active: boolean): void {
    if (active === this.appActive) return;
    this.appActive = active;
    this.schedulePeriodic();
    if (active) {
      this.forceNext = true;
      this.trigger();
    }
  }

  async whenIdle(): Promise<void> {
    for (let i = 0; i < 1000 && this.loop; i++) {
      const current = this.loop;
      await current.catch(() => undefined);
      if (this.loop === current) break;
    }
  }

  // -------------------------------------------------------------------------
  // Internals: commands
  // -------------------------------------------------------------------------

  private async command<T>(fn: () => Promise<T>): Promise<T> {
    await this.ready;
    return this.lock.run(fn);
  }

  /**
   * Commands keep going into the outbox after a not_member answer: until the session knows whether
   * the user was removed (unsent() lists them) or switched household (the next engine re-addresses
   * them), an edit must never be dropped silently.
   */
  private accepting(): boolean {
    return !this.stopped;
  }

  private resolve(id: Uuid): Uuid {
    let cur = id;
    for (let i = 0; i < 8; i++) {
      const next = this.reduced.aliases.get(cur) ?? this.aliases.get(cur);
      if (next === undefined || next === cur) return cur;
      cur = next;
    }
    return cur;
  }

  private visible(id: Uuid): VisibleItem | undefined {
    return this.reduced.items.get(this.resolve(id));
  }

  private mutation<K extends MutationKind>(kind: K, payload: MutationPayloads[K]): Mutation {
    return {
      id: this.deps.uuid(),
      household_id: this.deps.householdId,
      kind,
      payload,
      client_created_at: new Date(this.clock.now()).toISOString(),
    } as Mutation;
  }

  private entries(): OutboxEntry[] {
    return this.outbox.filter((e) => e.mutation.household_id === this.deps.householdId);
  }

  private reduceWith(entries: OutboxEntry[]): ReduceOutput {
    return reduce({ base: this.items, entries, aliases: this.aliases, userId: this.deps.userId });
  }

  private simulate(m: Mutation): { sim: SimResult; out: ReduceOutput; entry: OutboxEntry } {
    const entry: OutboxEntry = {
      seq: Number.MAX_SAFE_INTEGER,
      mutation: m,
      state: 'pending',
      ackedSeq: null,
      result: null,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      localMeta: null,
    };
    const out = this.reduceWith([...this.entries(), entry]);
    return { sim: out.sims.get(m.id) ?? { outcome: 'noop', targetId: null }, out, entry };
  }

  /** Outbox first (transaction), then the in-memory mirror and the snapshot. Runs under the lock. */
  private async persist(m: Mutation, meta: LocalMeta, out: ReduceOutput, extra?: () => Promise<void>): Promise<void> {
    const seq = await this.deps.db.transaction(async () => {
      const s = await this.store.insertOutbox(m, meta);
      if (extra) await extra();
      return s;
    });
    this.outbox.push({
      seq,
      mutation: m,
      state: 'pending',
      ackedSeq: null,
      result: null,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      localMeta: meta,
    });
    this.reduced = out;
    this.publish(out);
    this.emitStatus();
    this.schedulePush(this.opts.pushDebounceMs);
  }

  private async revertAdd(mutationId: Uuid): Promise<void> {
    await this.ready;
    // Never touch a row that is on the wire: wait for its batch to be answered first.
    while (this.inFlight.has(mutationId) && this.loop) await this.loop.catch(() => undefined);
    const plan = await this.lock.run(async () => {
      const entry = this.outbox.find((e) => e.mutation.id === mutationId);
      if (entry && entry.mutation.kind !== 'add_item') return null;
      if (entry && entry.state === 'pending' && entry.attempts === 0 && !this.inFlight.has(mutationId)) {
        // Never sent: drop it, plus later pending edits of the row it alone created.
        const drop = [entry.mutation.id];
        if (entry.localMeta?.outcome === 'added' || entry.localMeta?.outcome === undefined) {
          const createdId = (entry.mutation as Mutation & { kind: 'add_item' }).payload.id;
          for (const e of this.outbox) {
            if (e.seq > entry.seq && e.state === 'pending' && !this.inFlight.has(e.mutation.id) && mutationTargets(e.mutation).includes(createdId)) {
              if (e.mutation.kind === 'clear_checked') continue;
              drop.push(e.mutation.id);
            }
          }
        }
        await this.deps.db.transaction(() => this.store.deleteOutbox(drop).then(() => undefined));
        const set = new Set(drop);
        this.outbox = this.outbox.filter((e) => !set.has(e.mutation.id));
        this.recompute();
        return null;
      }
      let result: MutationResult | null = null;
      let payload: MutationPayloads['add_item'] | null = null;
      let meta: LocalMeta | null = null;
      if (entry && entry.state === 'acked' && entry.result) {
        result = entry.result;
        payload = (entry.mutation as Mutation & { kind: 'add_item' }).payload;
        meta = entry.localMeta;
      } else if (entry && entry.state === 'pending') {
        // Sent, but no answer yet (e.g. the response was lost): the server may have applied it as a
        // new item, merged it into someone else's item, or restored a checked one. Never guess: hide
        // it now and queue the exact inverse once the idempotent re-send is answered (applyResults).
        if (!entry.localMeta?.revertOnAck) {
          const marked: LocalMeta = { ...(entry.localMeta ?? {}), revertOnAck: true };
          await this.store.updateLocalMeta(entry.mutation.id, marked);
          entry.localMeta = marked;
          this.recompute();
          this.schedulePush(0);
        }
        return null;
      } else {
        const log = await this.store.getAckLog(mutationId);
        if (log && log.kind === 'add_item') {
          result = log.result;
          payload = log.payload as MutationPayloads['add_item'];
          meta = log.localMeta;
        }
      }
      if (!result || !payload) return null;
      return { result, payload, meta };
    });
    if (!plan) return;
    const { result, payload, meta } = plan;
    const target = result.item_id ?? payload.id;
    if (result.replayed && !result.item_id) return;
    if (result.status === 'merged') {
      await this.incrementQuantity(target, -payload.quantity);
    } else if (result.status === 'restored') {
      await this.setChecked(target, true);
      if (meta?.outcome === 'restored' && meta.targetId === target && meta.prevQuantity !== undefined) {
        await this.updateItem(target, { quantity: meta.prevQuantity });
      }
    } else if (result.status === 'applied') {
      await this.deleteItem(target);
    }
  }

  /** The inverse of an acknowledged add, from the server's real result (see LocalMeta.revertOnAck). */
  private inverseOfAdd(payload: MutationPayloads['add_item'], result: MutationResult, meta: LocalMeta | null): Mutation[] {
    // Replayed after a household switch and its row is gone: nothing of this add is left to undo.
    if (result.replayed && !result.item_id) return [];
    const target = result.item_id ?? payload.id;
    if (result.status === 'merged') return [this.mutation('increment_quantity', { item_id: target, delta: -payload.quantity })];
    if (result.status === 'restored') {
      const out = [this.mutation('set_checked', { item_id: target, checked: true })];
      if (meta?.outcome === 'restored' && meta.targetId === target && meta.prevQuantity !== undefined) {
        out.push(this.mutation('update_item', { item_id: target, fields: { quantity: meta.prevQuantity } }));
      }
      return out;
    }
    return [this.mutation('delete_item', { item_id: target })];
  }

  /**
   * Undo of "Wissen" for one id. Returns true when a restore_item must be queued now: the clear was
   * answered and removed this very id. A clear still unsent loses the id from its payload; a clear
   * on the wire (or whose answer was lost) gets the id in restoreOnAck, and applyResults restores it
   * only if the server's answer lists it (another member may have deleted it first).
   */
  private async revertClear(clearMutationId: Uuid, itemId: Uuid): Promise<boolean> {
    await this.ready;
    while (this.inFlight.has(clearMutationId) && this.loop) await this.loop.catch(() => undefined);
    return this.lock.run(async () => {
      const entry = this.outbox.find((e) => e.mutation.id === clearMutationId);
      if (entry && entry.mutation.kind === 'clear_checked' && entry.state === 'pending') {
        const ids = entry.mutation.payload.item_ids;
        const raw = ids.find((i) => this.resolve(i) === this.resolve(itemId));
        if (raw === undefined) return false;
        if (entry.attempts === 0 && !this.inFlight.has(clearMutationId)) {
          const rest = ids.filter((i) => i !== raw);
          if (rest.length === 0) {
            await this.store.deleteOutbox([clearMutationId]);
            this.outbox = this.outbox.filter((e) => e !== entry);
          } else {
            await this.store.updatePayload(clearMutationId, { item_ids: rest });
            entry.mutation = { ...entry.mutation, payload: { item_ids: rest } };
          }
        } else {
          const meta: LocalMeta = { ...(entry.localMeta ?? {}), restoreOnAck: [...new Set([...(entry.localMeta?.restoreOnAck ?? []), raw])] };
          await this.store.updateLocalMeta(clearMutationId, meta);
          entry.localMeta = meta;
          this.schedulePush(0);
        }
        this.recompute();
        return false;
      }
      const log = await this.store.getAckLog(clearMutationId);
      if (!log || log.kind !== 'clear_checked') return true; // answer no longer known: restore
      const affected = (log.result.affected_ids ?? []).map((i) => this.resolve(i));
      return affected.includes(this.resolve(itemId));
    });
  }

  // -------------------------------------------------------------------------
  // Internals: loop
  // -------------------------------------------------------------------------

  private canSync(force: boolean): boolean {
    if (!this.started || this.stopped || this.membershipLost) return false;
    // An explicit sync (syncNow, foreground) is attempted even when NetInfo says offline: its
    // reachability check has false negatives, and a failed attempt only costs one request.
    if (force) return true;
    if (!this.deps.connectivity.isOnline()) return false;
    if (this.needsReauth) return false;
    const now = this.clock.now();
    return now >= this.transportBackoffUntil(now);
  }

  /** backoffUntil is wall-clock time: clamp it like next_attempt_at, so a clock set back cannot stall sync. */
  private transportBackoffUntil(now: number): number {
    if (this.backoffUntil > now + BACKOFF_MAX_MS) this.backoffUntil = now + BACKOFF_MAX_MS;
    return this.backoffUntil;
  }

  private trigger(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.loop) {
      this.rerun = true;
      return this.loop;
    }
    this.loop = (async () => {
      // Never complete synchronously: `this.loop` must be assigned before the finally clears it.
      await Promise.resolve();
      try {
        do {
          this.rerun = false;
          const force = this.forceNext;
          this.forceNext = false;
          if (!this.canSync(force)) break;
          await this.cycle();
        } while (this.rerun && !this.stopped);
      } catch (e) {
        this.report(e, 'cycle');
      } finally {
        this.loop = null;
        this.scheduleRetry();
      }
    })();
    return this.loop;
  }

  private schedulePush(delay: number): void {
    if (this.stopped || !this.started) return;
    const at = this.clock.now() + delay;
    if (this.timers.push !== null && this.pushTimerAt <= at) return;
    if (this.timers.push !== null) this.clock.clearTimeout(this.timers.push);
    this.pushTimerAt = at;
    this.timers.push = this.clock.setTimeout(() => {
      this.timers.push = null;
      this.pushTimerAt = Infinity;
      this.trigger();
    }, delay);
  }

  /** Arms one timer for the earliest of: global transport backoff, earliest per-row retry. */
  private scheduleRetry(): void {
    if (this.stopped || this.membershipLost) return;
    let at = Infinity;
    const now = this.clock.now();
    if (this.transportBackoffUntil(now) > now) at = this.backoffUntil;
    for (const e of this.outbox) {
      const due = effectiveAttemptAt(e, now);
      if (e.state === 'pending' && due > now && due < at) at = due;
    }
    if (at === Infinity) return;
    if (this.timers.retry !== null && this.retryTimerAt <= at && this.retryTimerAt > now) return;
    if (this.timers.retry !== null) this.clock.clearTimeout(this.timers.retry);
    this.retryTimerAt = at;
    this.timers.retry = this.clock.setTimeout(() => {
      this.timers.retry = null;
      this.retryTimerAt = Infinity;
      this.trigger();
    }, at - now);
  }

  private schedulePeriodic(): void {
    if (this.timers.periodic !== null) {
      this.clock.clearTimeout(this.timers.periodic);
      this.timers.periodic = null;
    }
    if (this.stopped || !this.appActive || this.opts.periodicPullMs <= 0) return;
    this.timers.periodic = this.clock.setTimeout(() => {
      this.timers.periodic = null;
      this.trigger();
      this.schedulePeriodic();
    }, this.opts.periodicPullMs);
  }

  private clearTimers(): void {
    for (const k of ['push', 'retry', 'periodic'] as const) {
      if (this.timers[k] !== null) this.clock.clearTimeout(this.timers[k]);
      this.timers[k] = null;
    }
    this.pushTimerAt = Infinity;
    this.retryTimerAt = Infinity;
  }

  private async cycle(): Promise<void> {
    if (this.timers.push !== null) {
      this.clock.clearTimeout(this.timers.push);
      this.timers.push = null;
      this.pushTimerAt = Infinity;
    }
    if (this.retryNow) {
      this.retryNow = false;
      for (const e of this.outbox) if (e.state === 'pending') e.nextAttemptAt = 0; // in memory; the DB keeps the schedule
    }
    const pushed = await this.pushAll();
    if (pushed === 'stop') return;
    await this.pullAll();
  }

  private onTransportError(e: unknown): void {
    if (e instanceof AuthRequiredError || (e as { authRequired?: unknown })?.authRequired === true) {
      this.needsReauth = true;
      this.emitStatus();
      return;
    }
    this.transportFailures++;
    this.backoffUntil = this.clock.now() + backoffDelay(this.transportFailures, this.opts.random);
  }

  private onSuccess(): void {
    this.transportFailures = 0;
    this.backoffUntil = 0;
    if (this.needsReauth) {
      this.needsReauth = false;
      this.emitStatus();
    }
  }

  /** Pushes all due outbox rows. 'stop' = do not pull (transport failure, auth, membership lost). */
  private async pushAll(): Promise<'ok' | 'stop'> {
    let single = false;
    for (let guard = 0; guard < 10_000; guard++) {
      if (this.stopped || this.membershipLost) return 'stop';
      const batch = await this.lock.run(async () => {
        const b = this.selectBatch(single ? 1 : this.opts.batchSize);
        if (b.length === 0) return b;
        // Persisted before the request: a row with attempts > 0 may have reached the server even
        // when no response arrives (undo of such an add must not just drop it locally).
        try {
          await this.store.markSent(b.map((e) => e.mutation.id));
        } catch (e) {
          for (const x of b) this.inFlight.delete(x.mutation.id);
          throw e;
        }
        for (const e of b) e.attempts += 1;
        return b;
      });
      if (batch.length === 0) return 'ok';
      let resp: ApplyMutationsResponse;
      try {
        resp = await this.deps.transport.applyMutations({
          household_id: this.deps.householdId,
          mutations: batch.map((e) => e.mutation),
        });
      } catch (e) {
        for (const b of batch) this.inFlight.delete(b.mutation.id);
        this.onTransportError(e);
        return 'stop';
      }
      try {
        if (!resp || typeof resp !== 'object') throw new Error('malformed apply_mutations response');
        if (!resp.ok) {
          if (resp.error === 'not_member') {
            await this.loseMembership();
            return 'stop';
          }
          if (resp.error === 'not_authenticated') {
            this.onTransportError(new AuthRequiredError('not_authenticated'));
            return 'stop';
          }
          // invalid_batch: isolate the offending mutation by sending one at a time.
          if (batch.length > 1) {
            single = true;
            continue;
          }
          await this.lock.run(() =>
            this.applyResults(batch, {
              ok: true,
              server_seq: this.lastSeq,
              results: [{ id: batch[0]!.mutation.id, status: 'rejected', reason: 'invalid' }],
            }),
          );
          continue;
        }
        this.onSuccess();
        await this.lock.run(() => this.applyResults(batch, resp as Extract<ApplyMutationsResponse, { ok: true }>));
      } finally {
        for (const b of batch) this.inFlight.delete(b.mutation.id);
      }
    }
    return 'ok';
  }

  /**
   * Up to `limit` due pending rows in seq order. Per-item order is preserved: once a row is held back
   * (backoff), every later row touching the same item (or the item it creates) is held back too.
   * add_item is deduplicated by name on the server, so a later add whose name matches any name a
   * held-back row reads or writes (delete, rename, check, another add) is held back as well.
   */
  private selectBatch(limit: number): OutboxEntry[] {
    const now = this.clock.now();
    const blocked = new Set<Uuid>();
    const blockedNames = new Set<string>();
    const batch: OutboxEntry[] = [];
    for (const e of this.outbox) {
      if (batch.length >= limit) break;
      if (e.state !== 'pending' || e.mutation.household_id !== this.deps.householdId) continue;
      const targets = mutationTargets(e.mutation).flatMap((t) => [t, this.resolve(t)]);
      const addName = e.mutation.kind === 'add_item' ? normalizeName(e.mutation.payload.name) : null;
      if (
        effectiveAttemptAt(e, now) > now ||
        targets.some((t) => blocked.has(t)) ||
        (addName !== null && blockedNames.has(addName)) ||
        this.inFlight.has(e.mutation.id)
      ) {
        for (const t of targets) blocked.add(t);
        for (const n of this.namesTouched(e.mutation, targets)) blockedNames.add(n);
        continue;
      }
      // The server applies nothing after a 'retry' in the same batch. A row that failed before is
      // therefore sent in a batch of its own, so it cannot keep holding back unrelated rows.
      if (e.lastError !== null) {
        if (batch.length === 0) batch.push(e);
        else {
          for (const t of targets) blocked.add(t);
          for (const n of this.namesTouched(e.mutation, targets)) blockedNames.add(n);
        }
        if (batch.length === 1 && batch[0] === e) break;
        continue;
      }
      batch.push(e);
      // An undone add/clear still waiting for its answer: its inverse is queued once the answer is
      // known and must reach the server before any later edit of the same item or name.
      if (e.localMeta?.revertOnAck || e.localMeta?.restoreOnAck?.length) {
        for (const t of targets) blocked.add(t);
        for (const n of this.namesTouched(e.mutation, targets)) blockedNames.add(n);
      }
    }
    for (const e of batch) this.inFlight.add(e.mutation.id);
    return batch;
  }

  /** Normalized names a mutation reads or writes (current server/visible names plus a new name). */
  private namesTouched(m: Mutation, targets: Uuid[]): string[] {
    const out: string[] = [];
    if (m.kind === 'add_item') out.push(normalizeName(m.payload.name));
    if (m.kind === 'update_item' && m.payload.fields.name !== undefined) out.push(normalizeName(m.payload.fields.name));
    for (const t of targets) {
      const base = this.items.get(t);
      const vis = this.reduced.items.get(t);
      if (base) out.push(base.normalized_name);
      if (vis) out.push(vis.normalized_name);
    }
    return out;
  }

  private itemNameFor(m: Mutation): string {
    if (m.kind === 'add_item') return m.payload.name;
    const ids = mutationTargets(m);
    const names = ids
      .map((id) => this.reduced.items.get(this.resolve(id))?.name ?? this.items.get(this.resolve(id))?.name)
      .filter((n): n is string => !!n);
    if (m.kind === 'clear_checked') return names.length ? names.join(', ') : `${ids.length} afgevinkte items`;
    return names[0] ?? '';
  }

  /** Applies the per-mutation results of one batch. Runs under the lock. */
  private async applyResults(batch: OutboxEntry[], resp: Extract<ApplyMutationsResponse, { ok: true }>): Promise<void> {
    const byId = new Map<Uuid, MutationResult>();
    for (const r of resp.results ?? []) if (r && typeof r.id === 'string') byId.set(r.id, r);
    const now = this.clock.now();
    const after: (() => void)[] = [];
    const removed = new Set<Uuid>();
    const newFailed: FailedMutation[] = [];
    // Working copies so later rows in this batch see earlier decisions (state, payload rewrites).
    const state = new Map<Uuid, { state: OutboxEntry['state']; payload: Mutation['payload'] }>();
    const pendingAddIds = (beforeSeq: number): Set<Uuid> => {
      const s = new Set<Uuid>();
      for (const e of this.outbox) {
        if (e.seq >= beforeSeq || removed.has(e.mutation.id)) continue;
        const st = state.get(e.mutation.id)?.state ?? e.state;
        if (st === 'pending' && e.mutation.kind === 'add_item') s.add(e.mutation.payload.id);
      }
      return s;
    };

    await this.deps.db.transaction(async () => {
      for (const e of batch) {
        const m = e.mutation;
        const r = byId.get(m.id);
        const status = r?.status;
        if (r && (status === 'applied' || status === 'merged' || status === 'restored')) {
          const ackedSeq = typeof r.server_seq === 'number' ? r.server_seq : resp.server_seq;
          await this.store.markAcked(m.id, ackedSeq, r);
          let meta = e.localMeta;
          if (m.kind === 'add_item' && meta?.revertOnAck) {
            // Undone while unanswered: now that the real outcome is known, queue its exact inverse
            // in the same transaction (a crash cannot lose or double it).
            meta = { ...meta };
            delete meta.revertOnAck;
            await this.store.updateLocalMeta(m.id, meta);
            for (const inv of this.inverseOfAdd(m.payload, r, meta)) {
              const target = mutationTargets(inv)[0];
              const invMeta: LocalMeta = { outcome: 'updated', targetId: target, orderAfter: e.seq };
              const seq = await this.store.insertOutbox(inv, invMeta);
              after.push(() => {
                this.outbox.push({ seq, mutation: inv, state: 'pending', ackedSeq: null, result: null, attempts: 0, nextAttemptAt: 0, lastError: null, localMeta: invMeta });
              });
            }
            const cleared = meta;
            after.push(() => {
              e.localMeta = cleared;
            });
          }
          if (m.kind === 'clear_checked' && meta?.restoreOnAck?.length) {
            // Undone while unanswered: restore exactly the undone ids this clear really removed.
            const affected = new Set((r.affected_ids ?? []).map((i) => this.resolve(i)));
            const undone = meta.restoreOnAck;
            meta = { ...meta };
            delete meta.restoreOnAck;
            await this.store.updateLocalMeta(m.id, meta);
            for (const raw of undone) {
              if (!affected.has(this.resolve(raw))) continue;
              const inv = this.mutation('restore_item', { item_id: this.resolve(raw) });
              const invMeta: LocalMeta = { outcome: 'updated', targetId: this.resolve(raw), orderAfter: e.seq };
              const seq = await this.store.insertOutbox(inv, invMeta);
              after.push(() => {
                this.outbox.push({ seq, mutation: inv, state: 'pending', ackedSeq: null, result: null, attempts: 0, nextAttemptAt: 0, lastError: null, localMeta: invMeta });
              });
            }
            const cleared = meta;
            after.push(() => {
              e.localMeta = cleared;
            });
          }
          if (m.kind === 'add_item' || m.kind === 'clear_checked') {
            await this.store.logAck({ id: m.id, kind: m.kind, payload: m.payload, result: r, localMeta: meta, ackedAt: now });
          }
          state.set(m.id, { state: 'acked', payload: m.payload });
          after.push(() => {
            e.state = 'acked';
            e.ackedSeq = ackedSeq;
            e.result = r;
            e.lastError = null;
          });
          // Redirect later pending rows that still address the old id (merge/restore/alias).
          const oldId = m.kind === 'add_item' ? m.payload.id : m.kind === 'clear_checked' ? null : m.payload.item_id;
          const newId = r.item_id;
          if (oldId && newId && newId !== oldId) {
            await this.store.insertAlias(oldId, newId);
            after.push(() => this.aliases.set(oldId, newId));
            for (const later of this.outbox) {
              if (later.seq <= e.seq || later.state !== 'pending' || removed.has(later.mutation.id)) continue;
              const rewritten = rewriteTarget(later.mutation, oldId, newId);
              if (!rewritten) continue;
              if (this.inFlight.has(later.mutation.id) && batch.includes(later)) continue; // already sent; server resolves the alias
              await this.store.updatePayload(later.mutation.id, rewritten.payload);
              after.push(() => {
                later.mutation = rewritten;
              });
            }
          }
          continue;
        }
        if (r && status === 'rejected') {
          // A dependent of an add that is still pending (e.g. the add got 'retry' in this batch) was
          // rejected not_found only because of ordering: re-queue it under a fresh id.
          if (r.reason === 'not_found') {
            const adds = pendingAddIds(e.seq);
            if (mutationTargets(m).some((t) => adds.has(t))) {
              const newId = this.deps.uuid();
              await this.store.renameOutbox(m.id, newId);
              const attempts = Math.max(1, e.attempts);
              const next = now + backoffDelay(attempts, this.opts.random);
              await this.store.markRetry(newId, attempts, next, 'dependency not_found');
              after.push(() => {
                e.mutation = { ...e.mutation, id: newId } as Mutation;
                e.attempts = attempts;
                e.nextAttemptAt = next;
                e.lastError = 'dependency not_found';
              });
              continue;
            }
          }
          if (m.kind === 'add_item' && e.localMeta?.revertOnAck) {
            // Undone and never applied: nothing to report.
            await this.store.deleteOutbox([m.id]);
            removed.add(m.id);
            continue;
          }
          const reason = r.reason ?? 'invalid';
          const f: FailedMutation = { mutationId: m.id, kind: m.kind, itemName: this.itemNameFor(m), reason, failedAt: now };
          await this.store.insertFailed(f, m);
          await this.store.deleteOutbox([m.id]);
          removed.add(m.id);
          newFailed.push(f);
          continue;
        }
        // 'retry', unknown status or missing result: keep pending with per-row backoff.
        const attempts = Math.max(1, e.attempts); // already counted when the batch was sent
        const next = now + backoffDelay(attempts, this.opts.random);
        const err = r ? `retry (${String(status)})` : 'no result';
        await this.store.markRetry(m.id, attempts, next, err);
        after.push(() => {
          e.attempts = attempts;
          e.nextAttemptAt = next;
          e.lastError = err;
        });
      }
    });
    for (const fn of after) fn();
    if (removed.size) this.outbox = this.outbox.filter((e) => !removed.has(e.mutation.id));
    this.outbox.sort(byOutboxOrder);
    if (newFailed.length) this.failed = [...this.failed, ...newFailed];
    this.recompute();
  }

  private async pullAll(): Promise<void> {
    for (let page = 0; page < 100_000; page++) {
      if (this.stopped || this.membershipLost) return;
      let resp: PullChangesResponse;
      try {
        resp = await this.deps.transport.pullChanges(this.deps.householdId, this.lastSeq, this.opts.pullPageSize);
      } catch (e) {
        this.onTransportError(e);
        return;
      }
      if (!resp || typeof resp !== 'object') {
        this.onTransportError(new Error('malformed pull_changes response'));
        return;
      }
      if (!resp.ok) {
        if (resp.error === 'not_member') await this.loseMembership();
        else this.onTransportError(new AuthRequiredError('not_authenticated'));
        return;
      }
      this.onSuccess();
      if (resp.reset_required && this.lastSeq > 0) {
        await this.lock.run(async () => {
          await this.deps.db.transaction(async () => {
            await this.store.clearItems();
            await this.store.setMeta('last_seq', '0');
          });
          this.items = new Map();
          this.lastSeq = 0;
          this.recompute();
        });
        continue;
      }
      const sinceSeq = this.lastSeq;
      await this.lock.run(async () => {
        if (this.lastSeq !== sinceSeq) return; // another writer moved the cursor; next loop re-pulls
        const rows = (resp.items ?? [])
          .filter((it) => it && it.household_id === this.deps.householdId)
          .map(normalizeRow);
        const cursor = Number(resp.server_seq);
        await this.deps.db.transaction(async () => {
          await this.store.upsertItems(rows);
          await this.store.setMeta('last_seq', String(cursor));
          if (resp.household) await this.store.setMeta('household', JSON.stringify(resp.household));
          // Acked overlays are dropped only after the LAST page: a row edited at seq <= cursor may
          // arrive on a later page (edited again by someone else), and must not flicker back.
          if (!resp.has_more) await this.store.deleteAckedUpTo(cursor);
        });
        for (const it of rows) {
          const prev = this.items.get(it.id);
          if (!prev || it.server_seq >= prev.server_seq) this.items.set(it.id, it);
        }
        this.lastSeq = cursor;
        const renamed = !!resp.household && resp.household.name !== this.household?.name;
        if (resp.household) this.household = resp.household;
        if (!resp.has_more) this.outbox = this.outbox.filter((e) => !(e.state === 'acked' && (e.ackedSeq ?? 0) <= cursor));
        this.recompute(renamed); // a household rename re-publishes so getHousehold() readers update
      });
      if (!resp.has_more) return;
    }
  }

  private async loseMembership(): Promise<void> {
    // stop() means the session is already moving on (leave, accept, sign-out, wipe): a not_member
    // answer of a request that was in flight is expected then and must not start the removal flow.
    if (this.membershipLost || this.stopped) return;
    this.membershipLost = true;
    // The outbox is kept as it is: the session asks the server whether this user was removed (then
    // unsent() lists these changes before the file is wiped) or switched household on another
    // device (then a new engine on this file re-addresses them to the new household, see start()).
    await this.lock.run(async () => undefined);
    this.clearTimers();
    for (const u of this.unsubs.splice(0)) {
      try {
        u();
      } catch (e) {
        this.report(e, 'unsubscribe');
      }
    }
    this.emitStatus();
    for (const l of [...this.membershipListeners]) {
      try {
        l();
      } catch (e) {
        this.report(e, 'onMembershipLost');
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals: snapshot + status
  // -------------------------------------------------------------------------

  private recompute(force = false): void {
    const out = this.reduceWith(this.entries());
    this.reduced = out;
    this.publish(out, force);
    this.emitStatus();
  }

  private publish(out: ReduceOutput, force = false): void {
    const prev = new Map<Uuid, VisibleItem>();
    for (const it of this.snapshot.open) prev.set(it.id, it);
    for (const it of this.snapshot.checked) prev.set(it.id, it);
    const reuse = (it: VisibleItem): VisibleItem => {
      const p = prev.get(it.id);
      return p && sameItems([p], [it]) ? p : it;
    };
    const lists = out.items.size ? toLists(out.items.values()) : EMPTY_LISTS;
    const open = lists.open.map(reuse);
    const checked = lists.checked.map(reuse);
    if (!force && this.snapshot.loaded && sameRefs(open, this.snapshot.open) && sameRefs(checked, this.snapshot.checked)) return;
    this.snapshot = {
      householdId: this.deps.householdId,
      open,
      checked,
      revision: this.snapshot.revision + 1,
      loaded: true,
    };
    for (const l of [...this.listeners]) {
      try {
        l(this.snapshot);
      } catch (e) {
        this.report(e, 'listener');
      }
    }
  }

  private emitStatus(): void {
    const pendingCount = this.outbox.reduce((n, e) => n + (e.state === 'pending' ? 1 : 0), 0);
    const online = this.deps.connectivity.isOnline();
    const icon: SyncStatus['icon'] = !online ? 'offline' : this.failed.length ? 'error' : 'idle';
    const s = this.status;
    if (
      s.icon === icon &&
      s.pendingCount === pendingCount &&
      s.failed === this.failed &&
      s.needsReauth === this.needsReauth &&
      s.lastPulledSeq === this.lastSeq
    ) {
      return;
    }
    this.status = { icon, pendingCount, failed: this.failed, needsReauth: this.needsReauth, lastPulledSeq: this.lastSeq };
    for (const l of [...this.statusListeners]) {
      try {
        l(this.status);
      } catch (e) {
        this.report(e, 'status listener');
      }
    }
  }

  private report(e: unknown, context: string): void {
    try {
      this.opts.onError?.(e, context);
    } catch {
      /* ignore */
    }
  }
}

/**
 * next_attempt_at is persisted wall-clock time. If the device clock jumped backwards (or the row
 * was scheduled by a clock that ran ahead), never hold a row longer than the maximum backoff.
 */
function effectiveAttemptAt(e: OutboxEntry, now: number): number {
  if (e.nextAttemptAt > now + BACKOFF_MAX_MS) e.nextAttemptAt = now + BACKOFF_MAX_MS; // clamp once (in memory)
  return e.nextAttemptAt;
}

function noop(itemId: Uuid, itemName: string): CommandResult {
  return { itemId, outcome: 'noop', undo: [], itemName };
}

function sameRefs<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Coerces wire values (numeric may arrive as string) into the ListItemRow shape. */
export function normalizeRow(it: ListItemRow): ListItemRow {
  return {
    ...it,
    quantity: roundQuantity(Number(it.quantity)),
    position: Number(it.position),
    server_seq: Number(it.server_seq),
    note: it.note ?? '',
    unit: it.unit as Unit,
    checked: !!it.checked,
    exclude_from_comparison: !!it.exclude_from_comparison,
  };
}

function rewriteTarget(m: Mutation, oldId: Uuid, newId: Uuid): Mutation | null {
  switch (m.kind) {
    case 'add_item':
      return null;
    case 'clear_checked': {
      if (!m.payload.item_ids.includes(oldId)) return null;
      const ids = [...new Set(m.payload.item_ids.map((i) => (i === oldId ? newId : i)))];
      return { ...m, payload: { item_ids: ids } };
    }
    default:
      if (m.payload.item_id !== oldId) return null;
      return { ...m, payload: { ...m.payload, item_id: newId } } as Mutation;
  }
}
