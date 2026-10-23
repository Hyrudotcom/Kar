import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { Linking } from 'react-native';

import { KV_KEYS } from '@/src/lib/backend/types';
import { LEGAL_URLS } from '@/src/lib/legal';

import { flush, makeBackend, renderApp } from '../../__tests__/helpers';
import { useSession } from '../../session/SessionProvider';
import { SignInScreen } from '../SignInScreen';

jest.mock('react-native-safe-area-context', () => require('../../__tests__/mocks').safeAreaMock());
jest.mock('expo-router', () => ({ useRouter: () => require('../../__tests__/helpers').mockRouter }));

function Probe() {
  const { state } = useSession();
  return state.kind === 'signedOut' ? <SignInScreen /> : null;
}

async function setup() {
  const backend = makeBackend();
  await renderApp(<Probe />, backend);
  await screen.findByText('Goedboodschap');
  return backend;
}

describe('Inloggen', () => {
  it('shows the Dutch sign-in screen with Apple, Google and e-mail code, no carousel', async () => {
    await setup();
    expect(screen.getByText('Samen één boodschappenlijst')).toBeTruthy();
    expect(screen.getByLabelText('Doorgaan met Apple')).toBeTruthy();
    expect(screen.getByLabelText('Doorgaan met Google')).toBeTruthy();
    expect(screen.getByText('E-mailadres')).toBeTruthy();
    expect(screen.getByLabelText('Stuur code')).toBeTruthy();
    expect(screen.getByText('Door verder te gaan ga je akkoord met de voorwaarden en het privacybeleid.')).toBeTruthy();
    expect(screen.getByLabelText('Ik heb een uitnodigingscode')).toBeTruthy();
  });

  it('D-02: terms and privacy policy are links that open before an account exists', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await setup();
    await act(async () => fireEvent.press(screen.getByLabelText('Voorwaarden')));
    await act(async () => fireEvent.press(screen.getByLabelText('Privacybeleid')));
    expect(open.mock.calls.map((c) => c[0])).toEqual([LEGAL_URLS.terms, LEGAL_URLS.privacy]);
    expect(screen.getByLabelText('Voorwaarden').props.accessibilityRole).toBe('link');
    open.mockRestore();
  });

  it('keeps showing progress after a correct code while the household loads', async () => {
    const backend = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const create = backend.households.createHousehold;
    backend.households.createHousehold = async (name) => {
      await gate;
      return create(name);
    };
    await act(async () => fireEvent.changeText(screen.getByTestId('email'), 'jan@voorbeeld.nl'));
    await act(async () => fireEvent.press(screen.getByLabelText('Stuur code')));
    await screen.findByText('Typ de code uit je mail');
    await act(async () => fireEvent.changeText(screen.getByTestId('otp'), '123456'));
    await flush(20);
    // Signed in, household still loading: the screen is busy, not idle with six filled cells.
    expect(backend.world.currentUser?.email).toBe('jan@voorbeeld.nl');
    expect(screen.getByLabelText('Bezig met inloggen')).toBeTruthy();
    expect(screen.getByLabelText('Ander e-mailadres').props.accessibilityState).toMatchObject({ disabled: true });
    await act(async () => release());
    await waitFor(() => expect(screen.queryByText('Typ de code uit je mail')).toBeNull());
  });

  it('validates the e-mail address', async () => {
    await setup();
    await act(async () => fireEvent.changeText(screen.getByTestId('email'), 'geen-mail'));
    await act(async () => fireEvent.press(screen.getByLabelText('Stuur code')));
    expect(screen.getByText('Vul een geldig e-mailadres in.')).toBeTruthy();
  });

  it('signs in with a 6-digit code (auto-submit at 6), rejects a wrong one, and silently creates "Thuis"', async () => {
    const backend = await setup();
    await act(async () => fireEvent.changeText(screen.getByTestId('email'), 'jan@voorbeeld.nl'));
    await act(async () => fireEvent.press(screen.getByLabelText('Stuur code')));
    expect(await screen.findByText('Typ de code uit je mail')).toBeTruthy();
    expect(screen.getByText('Gestuurd naar jan@voorbeeld.nl')).toBeTruthy();
    expect(screen.getByLabelText('Opnieuw sturen, kan over 30 seconden')).toBeTruthy();
    await act(async () => fireEvent.changeText(screen.getByTestId('otp'), '000000'));
    expect(await screen.findByText('Deze code klopt niet of is verlopen.')).toBeTruthy();
    expect(backend.world.currentUser).toBeNull();
    await act(async () => fireEvent.changeText(screen.getByTestId('otp'), '12345'));
    expect(backend.world.currentUser).toBeNull();
    await act(async () => fireEvent.changeText(screen.getByTestId('otp'), '123456'));
    await waitFor(() => expect(backend.world.currentUser?.email).toBe('jan@voorbeeld.nl'));
    const m = await waitFor(() => {
      const mm = backend.world.memberships.get(backend.world.currentUser!.id);
      expect(mm).toBeTruthy();
      return mm!;
    });
    expect(m.role).toBe('owner');
    expect(backend.world.householdRow(m.householdId)!.name).toBe('Thuis');
  });

  it('explains that signing in needs internet', async () => {
    const backend = await setup();
    backend.connectivity.set(false);
    await act(async () => fireEvent.changeText(screen.getByTestId('email'), 'jan@voorbeeld.nl'));
    await act(async () => fireEvent.press(screen.getByLabelText('Stuur code')));
    expect(screen.getByText('Geen internet. Inloggen en lid worden kan alleen online.')).toBeTruthy();
  });

  it('Apple and Google sign in with one tap (demo backend)', async () => {
    const backend = await setup();
    await act(async () => fireEvent.press(screen.getByLabelText('Doorgaan met Google')));
    await waitFor(() => expect(backend.world.currentUser?.email).toBe('demo-google@voorbeeld.nl'));
  });

  it('stores a typed invite code for after sign-in', async () => {
    const backend = await setup();
    await act(async () => fireEvent.press(screen.getByLabelText('Ik heb een uitnodigingscode')));
    await act(async () => fireEvent.changeText(screen.getByTestId('invite-code-input'), 'k7q'));
    await act(async () => fireEvent.press(screen.getByLabelText('Doorgaan')));
    expect(screen.getByText('Een code heeft 6 tekens, bijvoorbeeld K7QM4Z.')).toBeTruthy();
    await act(async () => fireEvent.changeText(screen.getByTestId('invite-code-input'), 'k7qm4z'));
    await act(async () => fireEvent.press(screen.getByLabelText('Doorgaan')));
    await flush();
    expect(await backend.kv.getItem(KV_KEYS.pendingInviteCode)).toBe('K7QM4Z');
    expect(screen.getByText('Code K7QM4Z bewaard. Log in om lid te worden.')).toBeTruthy();
  });
});
