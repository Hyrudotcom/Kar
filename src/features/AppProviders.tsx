/** Everything above the navigator: backend, session, prices, snackbar, join-invite sheet. */
import type { ReactNode } from 'react';

import type { Backend } from '@/src/lib/backend/types';

import { SnackbarProvider } from './feedback/SnackbarProvider';
import { JoinInviteSheet } from './household/JoinInviteSheet';
import { PriceProvider } from './route/PriceContext';
import { BackendProvider } from './session/BackendContext';
import { SessionProvider } from './session/SessionProvider';

export function AppProviders({ backend, children }: { backend: Backend; children: ReactNode }) {
  return (
    <BackendProvider backend={backend}>
      <SessionProvider>
        <PriceProvider>
          <SnackbarProvider>
            {children}
            <JoinInviteSheet />
          </SnackbarProvider>
        </PriceProvider>
      </SessionProvider>
    </BackendProvider>
  );
}
