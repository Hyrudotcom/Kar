/**
 * Device builds: always Supabase + the real sync engine (expo-sqlite, NetInfo). The in-memory demo
 * (and its "any 6-digit code works" sign-in) is not part of device bundles at all; it is only used by
 * the web preview (createBackend.web.ts). A build without Supabase configuration fails loudly.
 */
import { env, isSupabaseConfigured } from '../env';
import { createSupabaseBackend } from './supabaseBackend';
import type { Backend } from './types';

export class BackendConfigError extends Error {}

export function createBackend(): Backend {
  if (!isSupabaseConfigured()) {
    throw new BackendConfigError(
      `Kar is niet goed geconfigureerd (EXPO_PUBLIC_SUPABASE_URL ${env.supabaseUrl ? 'gezet' : 'ontbreekt'}, EXPO_PUBLIC_SUPABASE_ANON_KEY ${env.supabaseAnonKey ? 'gezet' : 'ontbreekt'}).`,
    );
  }
  return createSupabaseBackend();
}
