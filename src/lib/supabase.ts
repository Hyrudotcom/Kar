/**
 * The one Supabase client of the app (docs/architecture.md section 1). Session in a chunked
 * SecureStore adapter; tokens refresh only while the app is in the foreground.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import { appSecureStore, sessionStorageKey } from './appSecureStore';
import { env } from './env';
import { fetchWithTimeout } from './fetchWithTimeout';
import { createChunkedStorage } from './secureStorage';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  if (!env.supabaseUrl || !env.supabaseAnonKey) throw new Error('Supabase is not configured (EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY)');
  client = createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: {
      storage: createChunkedStorage(appSecureStore),
      storageKey: sessionStorageKey(env.supabaseUrl),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
    global: { fetch: fetchWithTimeout() },
  });
  if (Platform.OS !== 'web') {
    const c = client;
    AppState.addEventListener('change', (state) => {
      if (state === 'active') c.auth.startAutoRefresh();
      else c.auth.stopAutoRefresh();
    });
  }
  return client;
}
