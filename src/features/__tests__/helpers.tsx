/**
 * Test harness for screens: demo backend (in-memory FakeServer + household RPC fake), session,
 * prices and snackbar providers, and a mocked expo-router. Call `mockNativeModules()` at the top
 * of each test file (jest.mock calls must be in the test module itself, see below).
 */
import { act, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import type { AuthUser } from '@/src/lib/backend/types';
import { createDemoBackend, type DemoBackend, type DemoBackendOptions } from '@/src/lib/demo/demoBackend';

import { AppProviders } from '../AppProviders';
import { useSession } from '../session/SessionProvider';

export const mockRouter = {
  push: jest.fn(),
  navigate: jest.fn(),
  replace: jest.fn(),
  back: jest.fn(),
  canGoBack: jest.fn(() => true),
};

export function makeBackend(opts: DemoBackendOptions = {}): DemoBackend {
  return createDemoBackend({ seed: false, ...opts });
}

/** Signs in on the demo backend before rendering, so the session establishes "Thuis" itself. */
export async function signIn(backend: DemoBackend, email = 'jan@voorbeeld.nl'): Promise<AuthUser> {
  const r = await backend.auth.verifyEmailCode(email, '123456');
  if (!r.ok) throw new Error('sign in failed');
  return backend.world.currentUser!;
}

function ReadyGate({ children }: { children: ReactElement }) {
  const { state } = useSession();
  return state.kind === 'ready' ? children : null;
}

/** Renders `ui` inside the app providers once the session is ready. */
export async function renderReady(ui: ReactElement, backend: DemoBackend) {
  const utils = await render(
    <AppProviders backend={backend}>
      <ReadyGate>{ui}</ReadyGate>
    </AppProviders>,
  );
  await waitFor(() => expect(backend.world.currentUser && backend.world.memberships.get(backend.world.currentUser.id)).toBeTruthy());
  return utils;
}

/** Renders without waiting for a session (sign-in, gate screens). */
export async function renderApp(ui: ReactElement, backend: DemoBackend) {
  return render(<AppProviders backend={backend}>{ui}</AppProviders>);
}

export async function flush(ms = 0) {
  await act(async () => {
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    await Promise.resolve();
  });
}

export { screen };
