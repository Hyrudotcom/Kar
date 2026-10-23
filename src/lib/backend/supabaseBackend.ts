/**
 * Backend on Supabase (device builds). Household calls are RPCs that return `{ ok, ... }` values;
 * a thrown/transport error becomes `{ ok:false, error:'network' }` so the UI can say "Geen internet".
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

import type { Uuid } from '@/src/contracts';
import { countUnsentChanges, createSyncEngine, SupabaseSyncTransport, wipeLocalData } from '@/src/sync';
import { createNetInfoConnectivity, ExpoSqliteFactory } from '@/src/sync/native';

import { isGoogleConfigured } from '../auth/google';
import { createSecureKeyValue } from '../secureStorage';
import { getSupabase } from '../supabase';
import { createAuth, createHouseholds, createPrices } from './supabaseApis';
import type { AuthUser, Backend, LocalDataApi } from './types';

export { toAuthUser } from './supabaseApis';

function createLocal(sb: SupabaseClient, connectivity: ReturnType<typeof createNetInfoConnectivity>): LocalDataApi {
  const factory = new ExpoSqliteFactory();
  return {
    async openEngine(user: AuthUser, householdId: Uuid) {
      const db = await factory.open(user.id);
      const engine = createSyncEngine({
        db,
        transport: SupabaseSyncTransport.fromClient(sb, user.id),
        connectivity,
        userId: user.id,
        householdId,
        uuid: () => Crypto.randomUUID(),
      });
      await engine.start();
      return engine;
    },
    wipe: (userId, engine) => wipeLocalData({ engine, factory, userId }),
    countUnsent: (userId) => countUnsentChanges(factory, userId),
  };
}

export function createSupabaseBackend(): Backend {
  const sb = getSupabase();
  const connectivity = createNetInfoConnectivity();
  return {
    mode: 'supabase',
    auth: createAuth(sb),
    households: createHouseholds(sb),
    prices: createPrices(sb),
    local: createLocal(sb, connectivity),
    connectivity,
    kv: createSecureKeyValue(),
    providers: { apple: Platform.OS === 'ios', google: isGoogleConfigured() },
  };
}
