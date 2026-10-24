/**
 * Sync engine public API (platform-neutral). Device adapters live in `@/src/sync/native`,
 * Node test adapters in `@/src/sync/node/betterSqlite`, fakes in `@/src/sync/testing`.
 */
export { createSyncEngine, mutationTargets, type SyncEngineOptions } from './engine';
export type { GoedSyncEngine, PriceCacheEntry } from './types';
export { SyncInputError } from './validate';
export { failedAsText, failedSummary } from './failedText';
export { ManualConnectivity, systemClock, backoffDelay } from './util';
export { SupabaseSyncTransport, type SupabaseLike } from './transports/supabase';
export { wipeLocalData, countUnsentChanges } from './session';
export {
  SyncEngineContext,
  SyncEngineProvider,
  useSyncEngine,
  useList,
  useSyncStatus,
  useItem,
  useHistory,
  useMembershipLost,
} from './hooks';
