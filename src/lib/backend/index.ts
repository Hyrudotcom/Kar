import { createBackend } from './createBackend';
import type { Backend } from './types';

export * from './types';

let instance: Backend | null = null;

/** The app-wide backend (created once). Tests construct their own and pass it to <AppProviders>. */
export function getBackend(): Backend {
  if (!instance) instance = createBackend();
  return instance;
}
