import { createContext, useContext, type ReactNode } from 'react';

import type { Backend } from '@/src/lib/backend/types';

const BackendContext = createContext<Backend | null>(null);

export function BackendProvider({ backend, children }: { backend: Backend; children: ReactNode }) {
  return <BackendContext.Provider value={backend}>{children}</BackendContext.Provider>;
}

export function useBackend(): Backend {
  const b = useContext(BackendContext);
  if (!b) throw new Error('useBackend outside BackendProvider');
  return b;
}
