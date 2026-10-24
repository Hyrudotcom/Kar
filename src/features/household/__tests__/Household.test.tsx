import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';

import { INVITE_CODE_REGEX } from '@/src/contracts';

import { flush, makeBackend, renderApp, renderReady, signIn } from '../../__tests__/helpers';
import { ListScreen } from '../../list/ListScreen';
import { RemovedScreen } from '../../session/GateScreens';
import { useSession } from '../../session/SessionProvider';
import { HouseholdScreen } from '../HouseholdScreen';

jest.mock('react-native-safe-area-context', () => require('../../__tests__/mocks').safeAreaMock());
jest.mock('expo-router', () => ({ useRouter: () => require('../../__tests__/helpers').mockRouter }));

const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);

/** Jan owns "Thuis"; Sanne is a member. */
async function ownerSetup() {
  const backend = makeBackend();
  const jan = await signIn(backend);
  const ensured = await backend.households.createHousehold();
  if (!ensured.ok) throw new Error('no household');
  const hh = ensured.household.id;
  const sanne = backend.world.addUser('Sanne', 'sanne@voorbeeld.nl');
  backend.world.join(sanne.id, hh, 'member');
  await renderReady(<HouseholdScreen />, backend);
  await screen.findByText('Sanne');
  return { backend, jan, sanne, hh };
}

describe('Huishouden', () => {
  beforeEach(() => shareSpy.mockClear());

  it('shares the invite link with the code in the text (one active code, reused)', async () => {
    await ownerSetup();
    // D-03: no "Code vervangen" before a code exists.
    expect(screen.queryByLabelText('Code vervangen')).toBeNull();
    await act(async () => fireEvent.press(screen.getByLabelText('Deel lijst')));
    await flush();
    expect(shareSpy).toHaveBeenCalledTimes(1);
    const msg = (shareSpy.mock.calls[0]![0] as { message: string }).message;
    const m = /^Doe je boodschappen samen met mij in Kar: https:\/\/getkar\.nl\/j\/([A-Z2-9]{6}) · Code: ([A-Z2-9]{6})$/.exec(msg);
    expect(m).toBeTruthy();
    expect(m![1]).toBe(m![2]);
    expect(INVITE_CODE_REGEX.test(m![1]!)).toBe(true);
    expect(screen.getByText(`Code: ${m![1]}`)).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByLabelText('Deel lijst')));
    await flush();
    expect((shareSpy.mock.calls[1]![0] as { message: string }).message).toBe(msg);
    // Owner replaces the code: only after a confirmation (old links stop working).
    await act(async () => fireEvent.press(screen.getByLabelText('Code vervangen')));
    await flush();
    expect(screen.getByText('Code vervangen?')).toBeTruthy();
    expect(screen.getByText('Links en codes die je al hebt gedeeld werken dan niet meer.')).toBeTruthy();
    expect(screen.getByText(`Code: ${m![1]}`)).toBeTruthy(); // not replaced yet
    await act(async () => fireEvent.press(screen.getAllByLabelText('Code vervangen').at(-1)!));
    await flush();
    expect(screen.queryByText(`Code: ${m![1]}`)).toBeNull();
    expect(screen.getByText(/^Nieuwe code: [A-Z2-9]{6}\. De oude code werkt niet meer\.$/)).toBeTruthy();
  });

  it('shows members with initials and "Eigenaar"; the owner removes a member after confirmation', async () => {
    const { backend, sanne, hh } = await ownerSetup();
    expect(screen.getByText('jan (jij)')).toBeTruthy();
    expect(screen.getByText('Eigenaar')).toBeTruthy();
    expect(screen.getByText('S')).toBeTruthy(); // one letter for a single first name (D2-21)
    expect(screen.getByText('Ingelogd als jan@voorbeeld.nl')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByLabelText('Sanne verwijderen')));
    expect(screen.getByText('Sanne verwijderen uit Thuis?')).toBeTruthy();
    expect(screen.getByText('De uitnodigingscode wordt ook vervangen.')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByLabelText('Verwijderen')));
    await flush();
    await waitFor(() => expect(screen.queryByText('Sanne')).toBeNull());
    expect(backend.world.memberships.get(sanne.id)).toBeUndefined();
    expect(backend.world.membersOf(hh)).toHaveLength(1);
  });

  it('renames the household (owner only)', async () => {
    const { backend, hh } = await ownerSetup();
    const field = screen.getByTestId('household-name');
    await act(async () => fireEvent.changeText(field, 'Studentenhuis'));
    await act(async () => fireEvent(field, 'blur'));
    await flush();
    expect(backend.world.householdRow(hh)!.name).toBe('Studentenhuis');
  });

  it('a member sees no remove buttons, no "Code vervangen" and a read-only name', async () => {
    const backend = makeBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const hh = backend.world.server.createHousehold(sanne.id, 'Thuis');
    backend.world.join(sanne.id, hh, 'owner');
    await signIn(backend, 'tim@voorbeeld.nl');
    backend.world.join(backend.world.currentUser!.id, hh, 'member');
    await renderReady(<HouseholdScreen />, backend);
    await screen.findByText('sanne');
    expect(screen.queryByLabelText('sanne verwijderen')).toBeNull();
    expect(screen.queryByLabelText('Code vervangen')).toBeNull();
    expect(screen.getByTestId('household-name-readonly')).toBeTruthy();
    expect(screen.getByLabelText('Deel lijst')).toBeTruthy();
  });

  it('leaving creates a new empty "Thuis" silently', async () => {
    const { backend, jan, hh } = await ownerSetup();
    await act(async () => fireEvent.press(screen.getByLabelText('Huishouden verlaten')));
    expect(screen.getByText('Thuis verlaten?')).toBeTruthy();
    expect(screen.getByText('Je ziet deze lijst daarna niet meer.')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByLabelText('Verlaten')));
    await flush();
    await waitFor(() => expect(screen.getByText('Je hebt Thuis verlaten')).toBeTruthy());
    const now = backend.world.memberships.get(jan.id)!;
    expect(now.householdId).not.toBe(hh);
    expect(now.role).toBe('owner');
    // Ownership moved to the longest-standing member.
    expect(backend.world.membersOf(hh).map((m) => [m.display_name, m.role])).toEqual([['Sanne', 'owner']]);
  });

  it('leaving is disabled offline with an explanation', async () => {
    const { backend } = await ownerSetup();
    await act(async () => backend.connectivity.set(false));
    expect(screen.getByText('Verlaten en account verwijderen kan alleen online')).toBeTruthy();
    expect(screen.getByLabelText('Huishouden verlaten').props.accessibilityState.disabled).toBe(true);
  });

  it('the last member is warned that the household and list are deleted', async () => {
    const backend = makeBackend();
    await signIn(backend);
    await renderReady(<HouseholdScreen />, backend);
    await screen.findByText('jan (jij)');
    await act(async () => fireEvent.press(screen.getByLabelText('Account verwijderen')));
    expect(screen.getByText('Account verwijderen?')).toBeTruthy();
    expect(screen.getByText('Thuis en de lijst worden definitief verwijderd.')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getAllByLabelText('Account verwijderen').at(-1)!));
    await flush();
    await waitFor(() => expect(backend.world.currentUser).toBeNull());
    expect(backend.world.users.size).toBe(0);
  });
});

function App() {
  const { state } = useSession();
  if (state.kind === 'ready') return <ListScreen />;
  if (state.kind === 'removed') return <RemovedScreen />;
  return null;
}

describe('Lidmaatschap', () => {
  it('"Je bent geen lid meer van Thuis" after removal, then a new Thuis', async () => {
    const backend = makeBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const hh = backend.world.server.createHousehold(sanne.id, 'Thuis');
    backend.world.join(sanne.id, hh, 'owner');
    const jan = await signIn(backend);
    backend.world.join(jan.id, hh, 'member');
    await renderApp(<App />, backend);
    await screen.findByTestId('quick-add');
    await act(async () => {
      backend.world.leave(jan.id);
    });
    expect(await screen.findByText('Je bent geen lid meer van Thuis')).toBeTruthy();
    expect(screen.getByLabelText('Ik heb een uitnodigingscode')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByLabelText('Doorgaan')));
    await screen.findByTestId('quick-add');
    const m = backend.world.memberships.get(jan.id)!;
    expect(m.householdId).not.toBe(hh);
    expect(m.role).toBe('owner');
  });

  it('joins via a pending invite: "Word je lid van …?", items move along when alone', async () => {
    const backend = makeBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    backend.world.users.get(sanne.id)!.displayName = 'Sanne';
    const target = backend.world.server.createHousehold(sanne.id, 'Bij Sanne');
    backend.world.join(sanne.id, target, 'owner');
    backend.world.currentUser = sanne;
    const inv = await backend.households.createInvite(target);
    if (!inv.ok) throw new Error('invite');
    backend.world.currentUser = null;

    const jan = await signIn(backend);
    const own = await backend.households.createHousehold();
    if (!own.ok) throw new Error('hh');
    backend.world.addItemsAs(jan.id, own.household.id, [{ name: 'Melk', quantity: 2 }]);
    // As stored by the /j/<code> route (or "Ik heb een uitnodigingscode") before the app boots.
    await backend.kv.setItem('pending_invite_code', inv.code);
    await renderApp(<App />, backend);
    expect(await screen.findByText('Word je lid van ‘Bij Sanne’?')).toBeTruthy();
    expect(screen.getByText('Uitgenodigd door Sanne · 1 lid')).toBeTruthy();
    // Alone in the current household: no "Je verlaat dan …" line.
    expect(screen.queryByText(/Je verlaat dan/)).toBeNull();
    expect(backend.world.memberships.get(jan.id)!.householdId).toBe(own.household.id);
    await act(async () => fireEvent.press(screen.getByLabelText('Lid worden')));
    await flush();
    await waitFor(() => expect(backend.world.memberships.get(jan.id)!.householdId).toBe(target));
    expect(await screen.findByText('Je bent lid van Bij Sanne')).toBeTruthy();
    expect(await screen.findByLabelText('Melk, 2. Niet afgevinkt.')).toBeTruthy();
    expect(await backend.kv.getItem('pending_invite_code')).toBeNull();
  });

  it('shows the expired-code text and never joins without the tap', async () => {
    const backend = makeBackend();
    const sanne = backend.world.userByEmail('sanne@voorbeeld.nl');
    const target = backend.world.server.createHousehold(sanne.id, 'Bij Sanne');
    backend.world.join(sanne.id, target, 'owner');
    backend.world.currentUser = sanne;
    const inv = await backend.households.createInvite(target);
    if (!inv.ok) throw new Error('invite');
    await backend.households.createInvite(target, true); // replaced: old code revoked
    backend.world.currentUser = null;
    const jan = await signIn(backend);
    await backend.kv.setItem('pending_invite_code', inv.code);
    await renderApp(<App />, backend);
    expect(await screen.findByText('Deze code is verlopen. Een code is 7 dagen geldig. Vraag een nieuwe.')).toBeTruthy();
    expect(backend.world.memberships.get(jan.id)!.householdId).not.toBe(target);
  });
});
