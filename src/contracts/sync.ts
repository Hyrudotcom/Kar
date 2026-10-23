/**
 * Client sync engine contract. Owner: architect; implemented in src/sync/** (sync builder),
 * consumed by app/** + src/features/** (mobile builder). See docs/architecture.md section 5.
 */
import type { ListItemRow, Unit, Uuid } from './domain';
import type { ApplyMutationsRequest, ApplyMutationsResponse, Mutation, PullChangesResponse, RejectReason } from './mutations';

// ---------------------------------------------------------------------------
// Ports (injected so the engine runs in Node tests with better-sqlite3 + a fake transport)
// ---------------------------------------------------------------------------

export type SqlValue = string | number | null;

/** Minimal async SQLite port. App: expo-sqlite (openDatabaseAsync). Tests: better-sqlite3 wrapper. */
export interface SqlDriver {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number; lastInsertRowId: number }>;
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): Promise<T | null>;
  /** Runs fn in a single exclusive transaction; rolls back if fn throws. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Opens / deletes the per-user database file `gb-<userId>.db` (design-spec 5.9). */
export interface SqlDriverFactory {
  open(userId: Uuid): Promise<SqlDriver>;
  destroy(userId: Uuid): Promise<void>;
}

/** Thrown by a transport for network/5xx/timeouts: retried with backoff, mutations stay in the outbox. */
export class TransientSyncError extends Error {
  readonly transient = true;
}
/** Thrown by a transport when the session is missing/expired (401). Outbox kept for the same user id. */
export class AuthRequiredError extends Error {
  readonly authRequired = true;
}

export interface SyncTransport {
  applyMutations(req: ApplyMutationsRequest): Promise<ApplyMutationsResponse>;
  pullChanges(householdId: Uuid, sinceSeq: number, limit?: number): Promise<PullChangesResponse>;
  /**
   * Realtime nudge: invoke `onNudge` on any list_items / households / household_members change
   * for this household. The engine responds by pulling; payloads are never trusted as data.
   */
  subscribe(householdId: Uuid, onNudge: (source: 'items' | 'household' | 'membership') => void): () => void;
}

export interface Connectivity {
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SyncEngineDeps {
  db: SqlDriver;
  transport: SyncTransport;
  connectivity: Connectivity;
  userId: Uuid;
  householdId: Uuid;
  clock?: Clock;
  /** uuid v4 generator; app: expo-crypto randomUUID, tests: crypto.randomUUID */
  uuid: () => Uuid;
}

// ---------------------------------------------------------------------------
// View model exposed to the UI
// ---------------------------------------------------------------------------

/** A visible item = server state with pending outbox mutations replayed on top. */
export interface VisibleItem extends ListItemRow {
  /** true while at least one outbox mutation for this item is not yet acknowledged. */
  pending: boolean;
}

export interface ListSnapshot {
  householdId: Uuid;
  /** Open items, sorted by position desc then id. The UI applies the "nothing moves under your finger" layer itself. */
  open: VisibleItem[];
  /** Checked, not deleted, sorted by checked_at desc. */
  checked: VisibleItem[];
  /** Increments on every visible change (in-memory only, resets on restart). Price cache uses listFingerprint instead. */
  revision: number;
  /** false until the first local load finished (show 3 skeleton rows). */
  loaded: boolean;
}

export interface FailedMutation {
  mutationId: Uuid;
  kind: Mutation['kind'];
  /** Item name at time of failure, for "1 wijziging kon niet worden opgeslagen: <item>." */
  itemName: string;
  reason: RejectReason | 'not_member';
  failedAt: number;
}

/** design-spec 4.3 sync icon: exactly three visible states. 'idle' also covers "sending". */
export type SyncIconState = 'idle' | 'offline' | 'error';

export interface SyncStatus {
  icon: SyncIconState;
  pendingCount: number;
  failed: FailedMutation[];
  /** Session expired while offline: "Log opnieuw in om je wijzigingen te versturen". */
  needsReauth: boolean;
  lastPulledSeq: number;
}

// ---------------------------------------------------------------------------
// Commands. Every command writes to the SQLite outbox FIRST, then updates the snapshot (<50 ms).
// ---------------------------------------------------------------------------

/** Undo = inverse operation on current server state (design-spec 5.6), expressed as engine commands. */
export type UndoAction =
  /**
   * Undo of addItem, resolved by the engine at undo time from the add's server result (or local
   * simulation if not yet acked): applied -> delete_item; merged -> increment_quantity(target, -qty);
   * restored -> set_checked(target, true) + update_item quantity back to the previous value.
   */
  | { kind: 'revert_add'; mutationId: Uuid }
  | { kind: 'restore_item'; itemId: Uuid }
  | { kind: 'delete_item'; itemId: Uuid }
  | { kind: 'set_checked'; itemId: Uuid; checked: boolean }
  | { kind: 'increment_quantity'; itemId: Uuid; delta: number }
  | { kind: 'update_item'; itemId: Uuid; fields: { quantity?: number; name?: string; note?: string; unit?: Unit } };

export type LocalOutcome = 'added' | 'merged' | 'restored' | 'updated' | 'noop';

export interface CommandResult {
  /** The item the command affected locally (after local dedupe). */
  itemId: Uuid;
  outcome: LocalOutcome;
  /** Actions that undo this command; pass to SyncEngine.undo(). Empty for 'noop'. */
  undo: UndoAction[];
  /** Display name, for the snackbar ("Melk +1", "Melk teruggezet"). */
  itemName: string;
}

export interface HistoryEntry {
  normalized_name: string;
  display_name: string;
  unit: Unit;
  use_count: number;
  last_used_at: number;
}

export interface AddItemInput {
  name: string;
  quantity: number;
  unit: Unit;
  note?: string;
}

export interface SyncEngine {
  start(): Promise<void>;
  stop(): Promise<void>;

  getSnapshot(): ListSnapshot;
  subscribe(listener: (snapshot: ListSnapshot) => void): () => void;
  getStatus(): SyncStatus;
  subscribeStatus(listener: (status: SyncStatus) => void): () => void;

  /** Local dedupe mirrors the server (open same name+unit -> merge; checked -> restore). */
  addItem(input: AddItemInput): Promise<CommandResult>;
  updateItem(itemId: Uuid, fields: { name?: string; quantity?: number; unit?: Unit; note?: string; exclude_from_comparison?: boolean }): Promise<CommandResult>;
  incrementQuantity(itemId: Uuid, delta: number): Promise<CommandResult>;
  setChecked(itemId: Uuid, checked: boolean): Promise<CommandResult>;
  deleteItem(itemId: Uuid): Promise<CommandResult>;
  restoreItem(itemId: Uuid): Promise<CommandResult>;
  /** ids = the checked rows that were on screen when "Wissen" was tapped. */
  clearChecked(itemIds: Uuid[]): Promise<CommandResult[]>;
  undo(actions: UndoAction[]): Promise<void>;

  /** Push now / pull now (e.g. app foreground). Never throws; errors surface via status. */
  syncNow(): Promise<void>;
  /** Removes failed mutations ("Weggooien"). */
  discardFailed(mutationIds: Uuid[]): Promise<void>;
  /** Plain-text export of failed mutations ("Kopieer als tekst"). */
  failedAsText(): string;

  /** Household suggestion history (design-spec 3, SuggestionList), most used first. */
  getHistory(): Promise<HistoryEntry[]>;

  /** Fired once when the server says not_member (push or pull). The app runs the removal flow. */
  onMembershipLost(listener: () => void): () => void;
}
