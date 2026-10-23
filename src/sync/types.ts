/** Internal sync types (not part of src/contracts). */
import type {
  Mutation,
  MutationKind,
  MutationResult,
  SyncEngine,
  Uuid,
} from '@/src/contracts';

export type OutboxState = 'pending' | 'acked';

/** What the local reducer decided when the mutation was enqueued (persisted for undo). */
export interface LocalMeta {
  outcome?: 'added' | 'merged' | 'restored' | 'updated' | 'noop';
  targetId?: Uuid;
  /** add_item that restored a checked row: its quantity before the restore. */
  prevQuantity?: number;
  /**
   * Undo of an add that was sent but not answered: the add is hidden locally, and once the server's
   * real answer arrives (applied / merged / restored) its exact inverse is queued (applyResults).
   */
  revertOnAck?: boolean;
}

/** One outbox row, in memory (mirrors the `outbox` table). */
export interface OutboxEntry {
  seq: number;
  mutation: Mutation;
  state: OutboxState;
  ackedSeq: number | null;
  result: MutationResult | null;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  localMeta: LocalMeta | null;
}

export interface AckedLogEntry {
  id: Uuid;
  kind: MutationKind;
  payload: Mutation['payload'];
  result: MutationResult;
  localMeta: LocalMeta | null;
  ackedAt: number;
}

/** Moved to src/contracts/sync.ts; re-exported for existing imports. */
export type { PriceCacheEntry } from '@/src/contracts';

/** The engine's API: the contract plus a test helper. */
export interface GoedSyncEngine extends SyncEngine {
  /** Resolves when no sync cycle is running or scheduled to run immediately. Mainly for tests. */
  whenIdle(): Promise<void>;
}
