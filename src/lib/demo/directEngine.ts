/**
 * A SyncEngine that applies every command directly to the in-memory FakeServer (sync builder's
 * contract double). Used only by the demo backend (web preview without SQLite or network), so
 * there is no outbox: the server answers synchronously and the snapshot is the server list.
 * Semantics (dedupe, delete wins, increments, aliases) come from the FakeServer, not from here.
 */
import type {
  AddItemInput,
  CommandResult,
  Connectivity,
  FailedMutation,
  HistoryEntry,
  HouseholdRow,
  ListItemRow,
  ListSnapshot,
  Mutation,
  MutationKind,
  MutationPayloads,
  MutationResult,
  SyncStatus,
  UndoAction,
  Unit,
  Uuid,
  VisibleItem,
} from '@/src/contracts';
import { normalizeName } from '@/src/shared/normalize';
import { failedAsText } from '@/src/sync/failedText';
import type { FakeServer } from '@/src/sync/testing/fakeServer';
import type { PriceCacheEntry } from '@/src/sync/types';

import type { AppEngine } from '../backend/types';

interface AddRecord {
  result: MutationResult;
  quantity: number;
  unit: Unit;
  prevQuantity?: number;
}

export class DirectEngine implements AppEngine {
  private listeners = new Set<(s: ListSnapshot) => void>();
  private statusListeners = new Set<(s: SyncStatus) => void>();
  private membershipListeners = new Set<() => void>();
  private snapshot: ListSnapshot;
  private status: SyncStatus;
  private signature = '';
  private adds = new Map<Uuid, AddRecord>();
  private failed: FailedMutation[] = [];
  private history = new Map<string, HistoryEntry>();
  private priceCache: PriceCacheEntry | null = null;
  private unsubs: (() => void)[] = [];
  private lost = false;

  constructor(
    private readonly server: FakeServer,
    private readonly userId: Uuid,
    private readonly householdId: Uuid,
    private readonly connectivity: Connectivity,
    private readonly uuid: () => Uuid,
  ) {
    this.snapshot = { householdId, open: [], checked: [], revision: 0, loaded: false };
    this.status = { icon: 'idle', pendingCount: 0, failed: [], needsReauth: false, lastPulledSeq: 0 };
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.server.subscribeHousehold(this.householdId, this.userId, () => {
        this.checkMembership();
        this.refresh();
      }),
    );
    this.unsubs.push(this.connectivity.subscribe(() => this.emitStatus()));
    this.refresh(true);
    this.emitStatus();
  }

  async stop(): Promise<void> {
    for (const u of this.unsubs.splice(0)) u();
  }

  async dispose(): Promise<void> {
    await this.stop();
  }

  getHousehold(): HouseholdRow | null {
    const h = this.server.households.get(this.householdId);
    return h ? { id: h.id, name: h.name, created_at: h.created_at, last_seq: h.last_seq } : null;
  }

  /** The demo has no session expiry. */
  notifyReauthenticated(): void {}

  /** Changes are applied synchronously; there is nothing to sync on foreground. */
  setAppActive(): void {}

  getSnapshot(): ListSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (s: ListSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribeStatus(listener: (s: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onMembershipLost(listener: () => void): () => void {
    this.membershipListeners.add(listener);
    return () => this.membershipListeners.delete(listener);
  }

  // --- commands -------------------------------------------------------------------------------

  async addItem(input: AddItemInput): Promise<CommandResult> {
    const id = this.uuid();
    const norm = normalizeName(input.name);
    const checkedMatch = this.rows().find((r) => r.checked && r.normalized_name === norm && r.unit === input.unit);
    const { mutation, result } = this.apply('add_item', { id, name: input.name.trim(), quantity: input.quantity, unit: input.unit, note: input.note }, input.name);
    const itemId = result.item_id ?? id;
    this.adds.set(mutation.id, { result, quantity: input.quantity, unit: input.unit, prevQuantity: checkedMatch?.quantity });
    this.bumpHistory(input.name.trim(), input.unit);
    this.refresh();
    const outcome = result.status === 'merged' ? 'merged' : result.status === 'restored' ? 'restored' : result.status === 'rejected' ? 'noop' : 'added';
    return { itemId, outcome, undo: outcome === 'noop' ? [] : [{ kind: 'revert_add', mutationId: mutation.id }], itemName: this.row(itemId)?.name ?? input.name };
  }

  async updateItem(itemId: Uuid, fields: MutationPayloads['update_item']['fields']): Promise<CommandResult> {
    const before = this.row(itemId);
    const prev: Extract<UndoAction, { kind: 'update_item' }>['fields'] = {};
    if (before) {
      if (fields.name !== undefined) prev.name = before.name;
      if (fields.quantity !== undefined) prev.quantity = before.quantity;
      if (fields.unit !== undefined) prev.unit = before.unit;
      if (fields.note !== undefined) prev.note = before.note;
    }
    const { result } = this.apply('update_item', { item_id: itemId, fields }, before?.name ?? '');
    this.refresh();
    return this.cmd(itemId, result, [{ kind: 'update_item', itemId, fields: prev }]);
  }

  async incrementQuantity(itemId: Uuid, delta: number): Promise<CommandResult> {
    const { result } = this.apply('increment_quantity', { item_id: itemId, delta }, this.row(itemId)?.name ?? '');
    this.refresh();
    return this.cmd(itemId, result, [{ kind: 'increment_quantity', itemId, delta: -delta }]);
  }

  async setChecked(itemId: Uuid, checked: boolean): Promise<CommandResult> {
    const { result } = this.apply('set_checked', { item_id: itemId, checked }, this.row(itemId)?.name ?? '');
    this.refresh();
    return this.cmd(itemId, result, [{ kind: 'set_checked', itemId, checked: !checked }]);
  }

  async deleteItem(itemId: Uuid): Promise<CommandResult> {
    const name = this.row(itemId)?.name ?? '';
    const { result } = this.apply('delete_item', { item_id: itemId }, name);
    this.refresh();
    return { ...this.cmd(itemId, result, [{ kind: 'restore_item', itemId }]), itemName: name };
  }

  async restoreItem(itemId: Uuid): Promise<CommandResult> {
    const { result } = this.apply('restore_item', { item_id: itemId }, this.server.item(itemId)?.name ?? '');
    this.refresh();
    return this.cmd(itemId, result, [{ kind: 'delete_item', itemId }]);
  }

  async clearChecked(itemIds: Uuid[]): Promise<CommandResult[]> {
    if (itemIds.length === 0) return [];
    const names = new Map(itemIds.map((id) => [id, this.row(id)?.name ?? '']));
    const { result } = this.apply('clear_checked', { item_ids: itemIds }, '');
    this.refresh();
    return (result.affected_ids ?? []).map((id) => ({ itemId: id, outcome: 'updated', undo: [{ kind: 'restore_item', itemId: id }], itemName: names.get(id) ?? '' }));
  }

  async undo(actions: UndoAction[]): Promise<void> {
    for (const a of actions) {
      switch (a.kind) {
        case 'revert_add': {
          const rec = this.adds.get(a.mutationId);
          const target = rec?.result.item_id;
          if (!rec || !target) break;
          if (rec.result.status === 'applied') this.apply('delete_item', { item_id: target }, '');
          else if (rec.result.status === 'merged') this.apply('increment_quantity', { item_id: target, delta: -rec.quantity }, '');
          else if (rec.result.status === 'restored') {
            this.apply('set_checked', { item_id: target, checked: true }, '');
            if (rec.prevQuantity !== undefined) this.apply('update_item', { item_id: target, fields: { quantity: rec.prevQuantity } }, '');
          }
          break;
        }
        case 'restore_item':
          this.apply('restore_item', { item_id: a.itemId }, '');
          break;
        case 'delete_item':
          this.apply('delete_item', { item_id: a.itemId }, '');
          break;
        case 'set_checked':
          this.apply('set_checked', { item_id: a.itemId, checked: a.checked }, '');
          break;
        case 'increment_quantity':
          this.apply('increment_quantity', { item_id: a.itemId, delta: a.delta }, '');
          break;
        case 'update_item':
          if (Object.keys(a.fields).length) this.apply('update_item', { item_id: a.itemId, fields: a.fields }, '');
          break;
      }
    }
    this.refresh();
  }

  async syncNow(): Promise<void> {
    this.checkMembership();
    this.refresh();
  }

  async discardFailed(mutationIds: Uuid[]): Promise<void> {
    const drop = new Set(mutationIds);
    this.failed = this.failed.filter((f) => !drop.has(f.mutationId));
    this.emitStatus();
  }

  failedAsText(): string {
    return failedAsText(this.failed);
  }

  /** No outbox: every change was applied on the spot, so only failed ones are unsent. */
  unsent(): { count: number; text: string } {
    return { count: this.failed.length, text: failedAsText(this.failed) };
  }

  resolveId(itemId: Uuid): Uuid {
    let cur = itemId;
    for (let i = 0; i < 8; i++) {
      const a = this.server.aliases.get(cur);
      if (!a || a.household_id !== this.householdId || a.target_id === cur) return cur;
      cur = a.target_id;
    }
    return cur;
  }

  async getHistory(): Promise<HistoryEntry[]> {
    return [...this.history.values()].sort((a, b) => b.use_count - a.use_count || b.last_used_at - a.last_used_at);
  }

  async readPriceCache(): Promise<PriceCacheEntry | null> {
    return this.priceCache;
  }

  async writePriceCache(entry: PriceCacheEntry): Promise<void> {
    this.priceCache = entry;
  }

  // --- internals ------------------------------------------------------------------------------

  private apply<K extends MutationKind>(kind: K, payload: MutationPayloads[K], itemName: string): { mutation: Mutation; result: MutationResult } {
    const mutation = { id: this.uuid(), household_id: this.householdId, kind, payload, client_created_at: new Date().toISOString() } as Mutation;
    const res = this.server.applyMutations(this.userId, { household_id: this.householdId, mutations: [mutation] });
    if (!res.ok) {
      if (res.error === 'not_member') this.fireLost();
      const result: MutationResult = { id: mutation.id, status: 'rejected', reason: 'forbidden' };
      return { mutation, result };
    }
    const result = res.results[0]!;
    if (result.status === 'rejected') {
      this.failed = [...this.failed, { mutationId: mutation.id, kind, itemName, reason: result.reason ?? 'invalid', failedAt: Date.now() }];
      this.emitStatus();
    }
    return { mutation, result };
  }

  private cmd(itemId: Uuid, result: MutationResult, undo: UndoAction[]): CommandResult {
    const ok = result.status !== 'rejected';
    return { itemId, outcome: ok ? 'updated' : 'noop', undo: ok ? undo : [], itemName: this.row(itemId)?.name ?? '' };
  }

  private rows(): ListItemRow[] {
    return this.server.list(this.householdId);
  }

  private row(id: Uuid): ListItemRow | undefined {
    return this.rows().find((r) => r.id === id);
  }

  private bumpHistory(name: string, unit: Unit) {
    const key = `${normalizeName(name)}|${unit}`;
    const prev = this.history.get(key);
    this.history.set(key, {
      normalized_name: normalizeName(name),
      display_name: name,
      unit,
      use_count: (prev?.use_count ?? 0) + 1,
      last_used_at: Date.now(),
    });
  }

  private checkMembership() {
    const h = this.server.households.get(this.householdId);
    if (!h || !h.members.has(this.userId)) this.fireLost();
  }

  private fireLost() {
    if (this.lost) return;
    this.lost = true;
    for (const l of [...this.membershipListeners]) l();
  }

  private refresh(force = false) {
    const rows = this.rows();
    const signature = rows.map((r) => `${r.id}:${r.server_seq}`).join(',');
    if (!force && signature === this.signature && this.snapshot.loaded) return;
    this.signature = signature;
    const vis = (r: ListItemRow): VisibleItem => ({ ...r, pending: false });
    const open = rows.filter((r) => !r.checked).sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : 1)).map(vis);
    const checked = rows
      .filter((r) => r.checked)
      .sort((a, b) => (b.checked_at ?? '').localeCompare(a.checked_at ?? '') || (a.id < b.id ? -1 : 1))
      .map(vis);
    this.snapshot = { householdId: this.householdId, open, checked, revision: this.snapshot.revision + 1, loaded: true };
    for (const l of [...this.listeners]) l(this.snapshot);
  }

  private emitStatus() {
    const icon = !this.connectivity.isOnline() ? 'offline' : this.failed.length ? 'error' : 'idle';
    this.status = { icon, pendingCount: 0, failed: this.failed, needsReauth: false, lastPulledSeq: 0 };
    for (const l of [...this.statusListeners]) l(this.status);
  }
}
