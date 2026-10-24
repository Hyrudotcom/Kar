import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { Keyboard, StyleSheet } from 'react-native';

import { flush, makeBackend, renderReady, signIn } from '../../__tests__/helpers';
import { ListScreen } from '../ListScreen';

jest.mock('react-native-safe-area-context', () => require('../../__tests__/mocks').safeAreaMock());
jest.mock('expo-router', () => ({ useRouter: () => require('../../__tests__/helpers').mockRouter }));

async function setup() {
  const backend = makeBackend();
  await signIn(backend);
  await renderReady(<ListScreen />, backend);
  await screen.findByTestId('quick-add');
  return backend;
}

async function type(text: string) {
  const input = screen.getByTestId('quick-add');
  await act(async () => {
    fireEvent.changeText(input, text);
  });
  await act(async () => {
    fireEvent(input, 'submitEditing');
  });
  await flush();
}

const row = (label: string) => screen.getByLabelText(label);

/**
 * Screen-reader custom action. Called on the prop directly: RNTL treats views whose PanResponder
 * declines touch start as event-disabled, but VoiceOver/TalkBack deliver actions regardless.
 */
async function a11yAction(testID: string, actionName: string) {
  await act(async () => {
    screen.getByTestId(testID).props.onAccessibilityAction({ nativeEvent: { actionName } });
  });
  await flush();
}

describe('Mijn lijst', () => {
  it('starts empty with the household name and the Dutch empty state', async () => {
    await setup();
    expect(screen.getByText('Thuis')).toBeTruthy();
    expect(await screen.findByText('Je lijst is leeg')).toBeTruthy();
    expect(screen.getByText('Typ hierboven wat je nodig hebt.')).toBeTruthy();
    expect(screen.getByPlaceholderText('Voeg iets toe…')).toBeTruthy();
    expect(screen.getByLabelText('Huishouden')).toBeTruthy();
    // Sync icon is invisible in the normal state.
    expect(screen.queryByTestId('sync-icon')).toBeNull();
  });

  it('parses quantities, shows them muted, and keeps the input focused for the next item', async () => {
    await setup();
    await type('2 l melk');
    await type('500 g gehakt');
    await type('brood');
    expect(row('Melk, 2 liter. Niet afgevinkt.')).toBeTruthy();
    expect(row('Gehakt, 500 gram. Niet afgevinkt.')).toBeTruthy();
    expect(row('Brood. Niet afgevinkt.')).toBeTruthy();
    expect(screen.getByText('  2 l')).toBeTruthy();
    // Newest first.
    const labels = screen.getAllByTestId(/^row-/).map((r) => r.props.testID);
    expect(labels).toEqual(['row-Brood', 'row-Gehakt', 'row-Melk']);
    // Input was cleared after Enter.
    expect(screen.getByTestId('quick-add').props.value).toBe('');
  });

  it('shows the add row and local suggestions while typing', async () => {
    await setup();
    await act(async () => {
      fireEvent.changeText(screen.getByTestId('quick-add'), '2 kaa');
    });
    const list = screen.getByTestId('suggestions');
    expect(within(list).getByText('‘kaa’ toevoegen (2)')).toBeTruthy();
    expect(within(list).getAllByRole('button')).toHaveLength(4);
    await act(async () => {
      fireEvent.press(within(list).getByLabelText('Kaas toevoegen'));
    });
    await flush();
    expect(row('Kaas, 2. Niet afgevinkt.')).toBeTruthy();
  });

  it('merges a duplicate on the server with "Melk +1 · Ongedaan maken" and undoes it', async () => {
    await setup();
    await type('2 melk');
    await type('melk');
    expect(row('Melk, 3. Niet afgevinkt.')).toBeTruthy();
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(1);
    expect(screen.getByText('Melk +1')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Ongedaan maken'));
    });
    await flush();
    expect(row('Melk, 2. Niet afgevinkt.')).toBeTruthy();
  });

  it('keeps a checked row in place until 1.5 s of rest, then collapses it into Afgevinkt', async () => {
    jest.useFakeTimers();
    try {
      await setup();
      await type('melk');
      await type('brood');
      const melk = screen.getByTestId('row-Melk');
      await act(async () => {
        fireEvent.press(within(melk).getByTestId('checkbox'));
      });
      // Struck through immediately, but still in the open section, same position.
      expect(row('Melk. Afgevinkt.')).toBeTruthy();
      expect(screen.getAllByTestId(/^row-/).map((r) => r.props.testID)).toEqual(['row-Brood', 'row-Melk']);
      expect(screen.queryByTestId('checked-toggle')).toBeNull();
      // A finger on the list postpones the move.
      await act(async () => {
        fireEvent(screen.getByTestId('list'), 'touchStart');
        jest.advanceTimersByTime(3000);
      });
      expect(screen.queryByTestId('checked-toggle')).toBeNull();
      await act(async () => {
        fireEvent(screen.getByTestId('list'), 'touchEnd');
        jest.advanceTimersByTime(1400);
      });
      expect(screen.queryByTestId('checked-toggle')).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(screen.getByText('Afgevinkt (1)')).toBeTruthy();
      expect(screen.getAllByTestId(/^row-/).map((r) => r.props.testID)).toEqual(['row-Brood']);
      // Collapsed by default; expand shows the struck row.
      await act(async () => {
        fireEvent.press(screen.getByTestId('checked-toggle'));
      });
      expect(row('Melk. Afgevinkt.')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('typing the name of a checked item brings it back ("Melk teruggezet")', async () => {
    const backend = await setup();
    await type('melk');
    const id = backend.world.server.list(backend.world.memberships.get(backend.world.currentUser!.id)!.householdId)[0]!.id;
    await act(async () => {
      fireEvent.press(within(screen.getByTestId('row-Melk')).getByTestId('checkbox'));
    });
    await type('melk');
    expect(screen.getByText('Melk teruggezet')).toBeTruthy();
    expect(row('Melk. Niet afgevinkt.')).toBeTruthy();
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(1);
    expect(screen.getByTestId('row-Melk')).toBeTruthy();
    expect(backend.world.server.item(id)?.checked).toBe(false);
  });

  it('round 4: re-adding a settled checked item shows it in the open list at once, and typing again does not double it', async () => {
    jest.useFakeTimers();
    try {
      await setup();
      await type('melk');
      await type('brood');
      await a11yAction('row-Melk', 'toggle');
      await act(async () => {
        jest.advanceTimersByTime(1600);
      });
      await flush();
      expect(screen.getAllByTestId(/^row-/).map((r) => r.props.testID)).toEqual(['row-Brood']);
      await type('melk');
      expect(screen.getByText('Melk teruggezet')).toBeTruthy();
      expect(screen.getAllByTestId(/^row-/).map((r) => r.props.testID)).toEqual(['row-Melk', 'row-Brood']);
      expect(screen.queryByText(/Afgevinkt/)).toBeNull();
      expect(row('Melk. Niet afgevinkt.')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('round 4: quick repeated merges add up in one snackbar and one undo takes them all back', async () => {
    await setup();
    for (let i = 0; i < 4; i++) await type('melk');
    expect(row('Melk, 4. Niet afgevinkt.')).toBeTruthy();
    expect(screen.getByText('Melk +3')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Ongedaan maken'));
    });
    await flush();
    expect(row('Melk. Niet afgevinkt.')).toBeTruthy();
  });

  it('deletes via the accessibility action, adds deletions up in one snackbar and undoes all', async () => {
    await setup();
    await type('melk');
    await type('brood');
    await type('kaas');
    for (const name of ['Melk', 'Brood']) {
      await a11yAction(`row-${name}`, 'delete');
    }
    expect(screen.getByText('2 items verwijderd')).toBeTruthy();
    expect(screen.getAllByTestId(/^row-/).map((r) => r.props.testID)).toEqual(['row-Kaas']);
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Ongedaan maken'));
    });
    await flush();
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(3);
  });

  it('"Wissen" removes exactly the checked rows on screen, with undo', async () => {
    jest.useFakeTimers();
    try {
      await setup();
      await type('melk');
      await type('brood');
      for (const name of ['Melk', 'Brood']) {
        await a11yAction(`row-${name}`, 'toggle');
      }
      await act(async () => {
        jest.advanceTimersByTime(1600);
      });
      expect(screen.getByText('Alles afgevinkt')).toBeTruthy();
      expect(screen.getByText('Klaar met boodschappen?')).toBeTruthy();
      await act(async () => {
        fireEvent.press(screen.getByLabelText('Afgevinkte items wissen'));
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('2 items gewist')).toBeTruthy();
      expect(screen.getByText('Je lijst is leeg')).toBeTruthy();
      await act(async () => {
        fireEvent.press(screen.getByLabelText('Ongedaan maken'));
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText('Afgevinkt (2)')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows the quiet offline icon with its explanation sheet', async () => {
    const backend = await setup();
    await act(async () => backend.connectivity.set(false));
    const icon = await screen.findByLabelText('Offline');
    await act(async () => {
      fireEvent.press(icon);
    });
    expect(screen.getByText('Je bent offline. Je wijzigingen worden bewaard en verstuurd zodra je weer verbinding hebt.')).toBeTruthy();
    await act(async () => backend.connectivity.set(true));
    await waitFor(() => expect(screen.queryByLabelText('Offline')).toBeNull());
  });

  it('updates a visible row in place when another member edits it', async () => {
    const backend = await setup();
    await type('melk');
    const w = backend.world;
    const hh = w.memberships.get(w.currentUser!.id)!.householdId;
    const sanne = w.addUser('Sanne');
    w.join(sanne.id, hh, 'member');
    const id = w.server.list(hh)[0]!.id;
    await act(async () => {
      w.server.applyMutations(sanne.id, {
        household_id: hh,
        mutations: [{ id: 'm-1', household_id: hh, kind: 'update_item', payload: { item_id: id, fields: { quantity: 4, note: 'lactosevrij' } }, client_created_at: new Date().toISOString() }],
      });
    });
    expect(await screen.findByLabelText('Melk, 4, lactosevrij. Niet afgevinkt.')).toBeTruthy();
  });
});

describe('round 3: undo snackbar above the keyboard', () => {
  it('moves the snackbar above an open keyboard while adding items', async () => {
    const handlers = new Map<string, ((e: unknown) => void)[]>();
    const spy = jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, fn: (e: unknown) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return { remove: () => undefined } as never;
    }) as never);
    try {
      await setup();
      const fire = async (event: string, e?: unknown) => {
        await act(async () => {
          for (const fn of handlers.get(event) ?? []) fn(e);
        });
      };
      await fire('keyboardDidShow', { endCoordinates: { height: 320 } });
      await type('melk');
      await type('melk');
      expect(screen.getByText('Melk +1')).toBeTruthy();
      const bottom = () => StyleSheet.flatten(screen.getByTestId('snackbar-host').props.style).bottom as number;
      expect(bottom()).toBeGreaterThanOrEqual(320);
      await fire('keyboardDidHide');
      expect(bottom()).toBeLessThan(320);
    } finally {
      spy.mockRestore();
    }
  });
});
