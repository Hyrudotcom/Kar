/** Everything above the navigator: backend, session, prices, snackbar, join-invite sheet. */
import type { ReactNode } from 'react';

import type { Backend } from '@/src/lib/backend/types';

import { SnackbarProvider } from './feedback/SnackbarProvider';
import { JoinInviteSheet } from './household/JoinInviteSheet';
import { PriceProvider } from './route/PriceContext';
import { BackendProvider } from './session/BackendContext';
import { SessionProvider, useSession } from './session/SessionProvider';

/** The snackbar is cleared whenever the session leaves `ready` or its engine changes. */
function SessionSnackbar({ children }: { children: ReactNode }) {
  const { state } = useSession();
  return <SnackbarProvider resetKey={state.kind === 'ready' ? state.engine : state.kind}>{children}</SnackbarProvider>;
}

export function AppProviders({ backend, children }: { backend: Backend; children: ReactNode }) {
  return (
    <BackendProvider backend={backend}>
      <SessionProvider>
        <PriceProvider>
          <SessionSnackbar>
            {children}
            <JoinInviteSheet />
          </SessionSnackbar>
        </PriceProvider>
      </SessionProvider>
    </BackendProvider>
  );
}
