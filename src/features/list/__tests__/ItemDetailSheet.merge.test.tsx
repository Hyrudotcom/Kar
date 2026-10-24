/**
 * Regression: an offline add that the server merges into another member's row (same name) moves to
 * the server's row id. The open detail sheet must follow it, not report "Melk is verwijderd" and
 * drop the note being typed.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { flush, renderApp, signIn } from '../../__tests__/helpers';
import { realBackend } from '../../__tests__/realBackend';
import { useSession } from '../../session/SessionProvider';
import { ListScreen } from '../ListScreen';

jest.mock('react-native-safe-area-context', () => require('../../__tests__/mocks').safeAreaMock());
jest.mock('expo-router', () => ({ useRouter: () => require('../../__tests__/helpers').mockRouter }));

function App() {
  const { state } = useSession();
  return state.kind === 'ready' ? <ListScreen /> : null;
}

it('keeps the sheet open on the merged row and saves the note there', async () => {
  const { backend } = realBackend();
  const bram = backend.world.userByEmail('bram@voorbeeld.nl');
  const hh = backend.world.server.createHousehold(bram.id, 'Thuis');
  backend.world.join(bram.id, hh, 'owner');
  const anna = await signIn(backend, 'anna@voorbeeld.nl');
  backend.world.join(anna.id, hh, 'member');
  await renderApp(<App />, backend);
  const input = await screen.findByTestId('quick-add');

  // Both offline in the store; Anna adds Melk, Bram's Melk reaches the server first.
  await act(async () => backend.connectivity.set(false));
  await act(async () => fireEvent.changeText(input, 'melk'));
  await act(async () => fireEvent(input, 'submitEditing'));
  await flush(20);
  backend.world.addItemsAs(bram.id, hh, [{ name: 'Melk' }]);
  const target = backend.world.server.list(hh)[0]!.id;

  await act(async () => fireEvent.press(screen.getByTestId('open-Melk')));
  await act(async () => fireEvent.changeText(screen.getByTestId('detail-note'), 'halfvol'));

  // Signal is back: the add is merged into Bram's row while the sheet is open.
  await act(async () => backend.connectivity.set(true));
  await flush(50);
  expect(screen.queryByText('Melk is verwijderd')).toBeNull();
  expect(screen.getByTestId('detail-note').props.value).toBe('halfvol');
  await flush(1200); // the 1 s save pause
  await waitFor(() => expect(backend.world.server.item(target)).toMatchObject({ note: 'halfvol', quantity: 2 }));
  expect(backend.world.server.list(hh)).toHaveLength(1);
});
