/**
 * Web export is for visual inspection only (docs/architecture.md section 7): always the in-memory
 * demo backend, so no SQLite wasm or network is needed and screens render without a backend.
 */
import { createDemoBackend } from '../demo/demoBackend';
import type { Backend } from './types';

export function createBackend(): Backend {
  return createDemoBackend({ seed: true, browserConnectivity: true });
}
