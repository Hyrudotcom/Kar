/**
 * Device builds: always Supabase + the real sync engine (expo-sqlite, NetInfo).
 * The in-memory demo is only used when EXPO_PUBLIC_DEMO_MODE=1 is set explicitly (e.g. a design
 * review build); a build without Supabase configuration fails loudly instead of showing demo data.
 */
import { env, isDemoModeRequested, isSupabaseConfigured } from '../env';
import { createDemoBackend } from '../demo/demoBackend';
import { createSupabaseBackend } from './supabaseBackend';
import type { Backend } from './types';

export class BackendConfigError extends Error {}

export function createBackend(): Backend {
  if (isDemoModeRequested()) return createDemoBackend({ seed: true });
  if (!isSupabaseConfigured()) {
    throw new BackendConfigError(
      `Goedboodschap is niet goed geconfigureerd (EXPO_PUBLIC_SUPABASE_URL ${env.supabaseUrl ? 'gezet' : 'ontbreekt'}, EXPO_PUBLIC_SUPABASE_ANON_KEY ${env.supabaseAnonKey ? 'gezet' : 'ontbreekt'}).`,
    );
  }
  return createSupabaseBackend();
}
