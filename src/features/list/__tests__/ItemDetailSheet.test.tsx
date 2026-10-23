import { act, fireEvent, screen } from '@testing-library/react-native';

import { flush, makeBackend, renderReady, signIn } from '../../__tests__/helpers';
import { addedByText } from '../ItemDetailSheet';
import { ListScreen } from '../ListScreen';

jest.mock('react-native-safe-area-context', () => require('../../__tests__/mocks').safeAreaMock());
jest.mock('expo-router', () => ({ useRouter: () => require('../../__tests__/helpers').mockRouter }));

async function setupWithMilk() {
  const backend = makeBackend();
  const me = await signIn(backend);
  await renderReady(<ListScreen />, backend);
  const input = await screen.findByTestId('quick-add');
  await act(async () => fireEvent.changeText(input, '2 melk'));
  await act(async () => fireEvent(input, 'submitEditing'));
  await flush();
  const hh = backend.world.memberships.get(me.id)!.householdId;
  return { backend, me, hh, id: backend.world.server.list(hh)[0]!.id };
}

describe('Itemdetail', () => {
  it('opens on row tap with name, quantity, note and "Toegevoegd door jou"', async () => {
    await setupWithMilk();
    await act(async () => fireEvent.press(screen.getByTestId('open-Melk')));
    await flush();
    expect(screen.getByTestId('detail-name').props.value).toBe('Melk');
    expect(screen.getByTestId('detail-quantity').props.value).toBe('2');
    expect(screen.getByText('Hoeveelheid')).toBeTruthy();
    expect(screen.getByText('Notitie')).toBeTruthy();
    expect(screen.getByText(/^Toegevoegd door jou · \d\d:\d\d$/)).toBeTruthy();
    expect(screen.getByLabelText('Verwijderen')).toBeTruthy();
    expect(screen.queryByText('Klaar')).toBeNull();
  });

  it('saves after a 1 s pause using the same quantity parser, and rejects nonsense with a hint', async () => {
    jest.useFakeTimers();
    try {
      const { backend, id } = await setupWithMilk();
      await act(async () => fireEvent.press(screen.getByTestId('open-Melk')));
      await act(async () => fireEvent.changeText(screen.getByTestId('detail-quantity'), '1,5 l'));
      await act(async () => fireEvent.changeText(screen.getByTestId('detail-note'), 'halfvol'));
      expect(backend.world.server.item(id)!.quantity).toBe(2);
      await act(async () => {
        jest.advanceTimersByTime(1100);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(backend.world.server.item(id)).toMatchObject({ quantity: 1.5, unit: 'l', note: 'halfvol' });
      await act(async () => fireEvent.changeText(screen.getByTestId('detail-quantity'), 'heel veel'));
      await act(async () => {
        jest.advanceTimersByTime(1100);
      });
      expect(screen.getByText('Bijvoorbeeld 2, 500 g of 1,5 l')).toBeTruthy();
      expect(backend.world.server.item(id)!.quantity).toBe(1.5);
    } finally {
      jest.useRealTimers();
    }
  });

  it('closes with "… is verwijderd · Terugzetten" when someone else deletes the item', async () => {
    const { backend, hh, id } = await setupWithMilk();
    await act(async () => fireEvent.press(screen.getByTestId('open-Melk')));
    await flush();
    const sanne = backend.world.addUser('Sanne');
    backend.world.join(sanne.id, hh, 'member');
    await act(async () => {
      backend.world.server.applyMutations(sanne.id, {
        household_id: hh,
        mutations: [{ id: 'del-1', household_id: hh, kind: 'delete_item', payload: { item_id: id }, client_created_at: new Date().toISOString() }],
      });
    });
    await flush();
    expect(screen.queryByTestId('detail-name')).toBeNull();
    expect(screen.getByText('Melk is verwijderd')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByLabelText('Terugzetten')));
    await flush();
    expect(backend.world.server.item(id)!.deleted_at).toBeNull();
    expect(screen.getByLabelText('Melk, 2. Niet afgevinkt.')).toBeTruthy();
  });

  it('"Verwijderen" closes the sheet and offers undo', async () => {
    const { backend, id } = await setupWithMilk();
    await act(async () => fireEvent.press(screen.getByTestId('open-Melk')));
    await flush();
    await act(async () => fireEvent.press(screen.getByLabelText('Verwijderen')));
    await flush();
    expect(screen.getByText('Melk verwijderd')).toBeTruthy();
    expect(backend.world.server.item(id)!.deleted_at).not.toBeNull();
    await act(async () => fireEvent.press(screen.getByLabelText('Ongedaan maken')));
    await flush();
    expect(backend.world.server.item(id)!.deleted_at).toBeNull();
  });

  it('names the member who added the item', () => {
    const members = [{ household_id: 'h', user_id: 's', role: 'member' as const, joined_at: '', display_name: 'Sanne' }];
    const now = new Date();
    now.setHours(10, 42, 0, 0);
    expect(addedByText({ created_by: 's', created_at: now.toISOString() }, members, 'me')).toBe('Toegevoegd door Sanne · 10:42');
  });
});
