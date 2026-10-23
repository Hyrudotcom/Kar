/**
 * Outbox mutations and the apply_mutations / pull_changes RPC contract.
 * Owner: architect. Backend implements the SQL side, sync implements the client side.
 * See docs/architecture.md sections 4 and 5 for semantics.
 */
import type { HouseholdRow, IsoTimestamp, ListItemRow, Unit, Uuid } from './domain';

// ---------------------------------------------------------------------------
// Mutation payloads (wire format, snake_case)
// ---------------------------------------------------------------------------

/**
 * add_item: server resolution order (under the household row lock):
 *  1. item `id` already exists in this household (or is an alias) -> 'applied' (idempotent, no change)
 *  2. open item (not checked, not deleted) with same normalized_name + unit -> increment its
 *     quantity by `quantity`, record alias id -> target -> 'merged'
 *  3. checked (not deleted) item with same normalized_name + unit (most recently checked) ->
 *     unchecked, quantity := `quantity`, position := new top, alias recorded -> 'restored'
 *  4. otherwise insert with this id -> 'applied'
 */
export interface AddItemPayload {
  id: Uuid;
  name: string;
  quantity: number;
  unit: Unit;
  note?: string;
}

/** Per-field last-writer-wins (server order). Only present keys are written. quantity is an exact set. */
export interface UpdateItemPayload {
  item_id: Uuid;
  fields: {
    name?: string;
    quantity?: number;
    unit?: Unit;
    note?: string;
    exclude_from_comparison?: boolean;
  };
}

/** Server-side delta: quantity := quantity + delta. Rejected ('invalid') if the result would be <= 0. */
export interface IncrementQuantityPayload {
  item_id: Uuid;
  delta: number;
}

export interface SetCheckedPayload {
  item_id: Uuid;
  checked: boolean;
}

/** Tombstones the item. Idempotent: deleting a deleted item is 'applied'. */
export interface DeleteItemPayload {
  item_id: Uuid;
}

/** Undo of delete ("Ongedaan maken" / "Terugzetten"). The only way to clear a tombstone. */
export interface RestoreItemPayload {
  item_id: Uuid;
}

/**
 * "Wissen" in Afgevinkt: tombstones exactly these ids, but only those still checked and not deleted.
 * Result.affected_ids lists the ids actually tombstoned (undo = restore_item for each).
 */
export interface ClearCheckedPayload {
  item_ids: Uuid[];
}

export interface MutationPayloads {
  add_item: AddItemPayload;
  update_item: UpdateItemPayload;
  increment_quantity: IncrementQuantityPayload;
  set_checked: SetCheckedPayload;
  delete_item: DeleteItemPayload;
  restore_item: RestoreItemPayload;
  clear_checked: ClearCheckedPayload;
}

export type MutationKind = keyof MutationPayloads;
export const MUTATION_KINDS: readonly MutationKind[] = [
  'add_item',
  'update_item',
  'increment_quantity',
  'set_checked',
  'delete_item',
  'restore_item',
  'clear_checked',
];

/** One outbox entry as sent to the server. `id` is the idempotency key (client mutation id). */
export type Mutation = {
  [K in MutationKind]: {
    id: Uuid;
    household_id: Uuid;
    kind: K;
    payload: MutationPayloads[K];
    /** Informational only. Never used for conflict resolution (server order wins). */
    client_created_at: IsoTimestamp;
  };
}[MutationKind];

// ---------------------------------------------------------------------------
// apply_mutations(batch jsonb) -> jsonb
// ---------------------------------------------------------------------------

export interface ApplyMutationsRequest {
  household_id: Uuid;
  /** 1..100 mutations, applied sequentially in array order, each in its own subtransaction. */
  mutations: Mutation[];
}

/**
 * applied  - change made (or idempotent no-op that is still success)
 * merged   - add_item folded into an existing open item (result.item_id = target)
 * restored - add_item revived a checked item (result.item_id = target)
 * rejected - permanent: never retry; move to "kon niet worden opgeslagen"
 * retry    - transient server-side failure for this mutation; keep in outbox, retry with backoff
 */
export type MutationStatus = 'applied' | 'merged' | 'restored' | 'rejected' | 'retry';

export type RejectReason =
  | 'deleted' // target is tombstoned (delete wins)
  | 'not_found' // target id unknown in this household
  | 'invalid' // payload failed validation (lengths, unit, quantity <= 0, unknown kind)
  | 'forbidden'; // mutation household_id != batch household_id

export interface MutationResult {
  /** Echo of Mutation.id */
  id: Uuid;
  status: MutationStatus;
  reason?: RejectReason;
  /** Item the mutation finally applied to (after alias / merge resolution). */
  item_id?: Uuid;
  /** clear_checked only: ids actually tombstoned. */
  affected_ids?: Uuid[];
  /** server_seq assigned to the change, if any. */
  server_seq?: number;
  /** true if this result was replayed from the mutation log (already processed earlier). */
  replayed?: boolean;
}

export type ApplyMutationsResponse =
  | {
      ok: true;
      results: MutationResult[];
      /** households.last_seq after the batch. */
      server_seq: number;
    }
  | {
      ok: false;
      /** not_member: never retried; client goes to "Je bent geen lid meer" flow. */
      error: 'not_member' | 'invalid_batch' | 'not_authenticated';
    };

// ---------------------------------------------------------------------------
// pull_changes(p_household_id uuid, p_since_seq bigint, p_limit int default 500) -> jsonb
// ---------------------------------------------------------------------------

export type PullChangesResponse =
  | {
      ok: true;
      household: HouseholdRow;
      /** Rows with server_seq > since, ascending by server_seq. Includes tombstones unless since = 0. */
      items: ListItemRow[];
      /** Cursor to store: max server_seq in `items`, or since/last_seq when empty. */
      server_seq: number;
      has_more: boolean;
      /** true when since_seq is older than the tombstone purge horizon: wipe local items, pull from 0. */
      reset_required: boolean;
    }
  | { ok: false; error: 'not_member' | 'not_authenticated' };
