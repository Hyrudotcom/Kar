import { act, fireEvent, screen, within } from '@testing-library/react-native';

import type { PriceDataset } from '@/src/contracts';
import { DatasetBuilder } from '@/src/price/__tests__/fixtures';

import { flush, makeBackend, renderReady, signIn } from '../../__tests__/helpers';
import { RouteScreen, speakCents, storeAccessibilityLabel } from '../RouteScreen';

jest.mock('react-native-safe-area-context', () => require('../../__tests__/mocks').safeAreaMock());
jest.mock('expo-router', () => ({ useRouter: () => require('../../__tests__/helpers').mockRouter }));

const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

/** TEST FIXTURE ONLY: invented prices, never shown outside tests. */
function fixture(): PriceDataset {
  const b = new DatasetBuilder();
  b.data.chains = [
    { id: 'ah', name: 'Albert Heijn' },
    { id: 'jumbo', name: 'Jumbo' },
    { id: 'lidl', name: 'Lidl' },
  ];
  b.catalog('melk', ['melk'], 1000, 'ml').catalog('brood', ['brood'], 800, 'g');
  b.simple('melk', 'ah', 119, 1000, 'ml', ago(1));
  b.simple('brood', 'ah', 229, 800, 'g', ago(1));
  b.simple('melk', 'jumbo', 105, 1000, 'ml', ago(9));
  b.simple('brood', 'jumbo', 249, 800, 'g', ago(1));
  b.simple('melk', 'lidl', 99, 1000, 'ml', ago(1));
  return b.data;
}

async function setup(opts: Parameters<typeof makeBackend>[0] = {}, items: { name: string; quantity?: number }[] = []) {
  const backend = makeBackend(opts);
  const me = await signIn(backend);
  const r = await backend.households.createHousehold();
  if (!r.ok) throw new Error('hh');
  backend.world.addItemsAs(me.id, r.household.id, items);
  await renderReady(<RouteScreen />, backend);
  await flush();
  return backend;
}

describe('Goedkoopste route', () => {
  it('v1: shows "Geen geverifieerde prijzen beschikbaar" with no button and no toggle', async () => {
    await setup({}, [{ name: 'Melk' }]);
    expect(await screen.findByText('Geen geverifieerde prijzen beschikbaar')).toBeTruthy();
    expect(screen.getByText('Welke winkel is voor je hele lijst het goedkoopst')).toBeTruthy();
    expect(screen.getByText(/We laten liever niets zien dan een verkeerde vergelijking\./)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText(/€/)).toBeNull();
  });

  it('price source unreachable: "Prijzen tijdelijk niet beschikbaar" with retry', async () => {
    await setup({ priceError: true }, [{ name: 'Melk' }]);
    expect(await screen.findByText('Prijzen tijdelijk niet beschikbaar')).toBeTruthy();
    expect(screen.getByText('Je lijst werkt gewoon.')).toBeTruthy();
    expect(screen.getByLabelText('Opnieuw proberen')).toBeTruthy();
  });

  it('with verified data: opt-in first, then only complete baskets are ranked and totalled', async () => {
    const backend = await setup({ priceDataset: fixture() }, [{ name: 'Melk', quantity: 2 }, { name: 'Brood' }]);
    expect(await screen.findByText('Ontbrekende prijzen tonen we eerlijk.')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByLabelText('Prijzen vergelijken')));
    await flush();
    expect(backend.world.optIn.get(backend.world.currentUser!.id)).toBe(true);

    expect(screen.getByText('2 items · oudste prijs 9 d')).toBeTruthy();
    const jumbo = screen.getByTestId('store-jumbo');
    expect(within(jumbo).getByText('€4,59')).toBeTruthy();
    expect(within(jumbo).getByText('Goedkoopste · 1 verouderd')).toBeTruthy();
    const ah = screen.getByTestId('store-ah');
    expect(within(ah).getByText('€4,67')).toBeTruthy();
    expect(within(ah).getByText('+€0,08')).toBeTruthy();
    // Incomplete basket: coverage, no amount, under "Onvolledig".
    expect(screen.getByText('Onvolledig')).toBeTruthy();
    const lidl = screen.getByTestId('store-lidl');
    expect(within(lidl).getByText('1 van 2 prijzen')).toBeTruthy();
    expect(within(lidl).queryByText(/€/)).toBeNull();
    expect(lidl.props.accessibilityLabel).toBe('Lidl, onvolledig, 1 van 2 prijzen.');
    expect(jumbo.props.accessibilityLabel).toBe('Jumbo, 2 van 2 prijzen, 1 verouderd, goedkoopste, 4 euro 59.');
    expect(screen.getByText('Webshopprijzen, kunnen in de winkel afwijken.')).toBeTruthy();

    // Lines of the incomplete store: the unknown price is "Geen prijs", never €0,00.
    await act(async () => fireEvent.press(lidl));
    const sheet = screen.getByTestId('store-sheet');
    expect(within(sheet).getByText('Geen prijs')).toBeTruthy();
    expect(within(sheet).queryByText('€0,00')).toBeNull();
    expect(within(sheet).getByText('€1,98')).toBeTruthy();
  });

  it('"Verkeerd product" makes that store incomplete, and "Toch gebruiken" reverts it', async () => {
    await setup({ priceDataset: fixture() }, [{ name: 'Melk', quantity: 2 }, { name: 'Brood' }]);
    await act(async () => fireEvent.press(await screen.findByLabelText('Prijzen vergelijken')));
    await flush();
    await act(async () => fireEvent.press(screen.getByTestId('store-jumbo')));
    await act(async () => fireEvent.press(within(screen.getByTestId('store-sheet')).getAllByRole('button')[0]!));
    await act(async () => fireEvent.press(screen.getByLabelText('Verkeerd product')));
    await flush();
    // Jumbo is now incomplete; Albert Heijn is the only complete basket.
    expect(within(screen.getByTestId('store-jumbo')).getByText('1 van 2 prijzen')).toBeTruthy();
    expect(within(screen.getByTestId('store-ah')).getByText('Enige complete mand')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByTestId('store-jumbo')));
    await act(async () => fireEvent.press(within(screen.getByTestId('store-sheet')).getAllByRole('button')[0]!));
    await act(async () => fireEvent.press(screen.getByLabelText('Toch gebruiken')));
    await flush();
    expect(within(screen.getByTestId('store-jumbo')).getByText('Goedkoopste · 1 verouderd')).toBeTruthy();
  });

  it('no complete basket: "Geen winkel heeft al je prijzen" and "Niet vergelijken" for items without any price', async () => {
    const backend = await setup({ priceDataset: fixture() }, [{ name: 'Melk' }, { name: 'Cadeautje oma' }]);
    await act(async () => fireEvent.press(await screen.findByLabelText('Prijzen vergelijken')));
    await flush();
    expect(screen.getByText('Geen winkel heeft al je prijzen')).toBeTruthy();
    expect(screen.queryByText(/^€/)).toBeNull();
    await act(async () => fireEvent.press(screen.getByLabelText('Cadeautje oma niet vergelijken')));
    await flush();
    expect(screen.getByText('1 van 2 items vergeleken · 1 uitgesloten · oudste prijs 9 d')).toBeTruthy();
    expect(within(screen.getByTestId('store-lidl')).getByText('€0,99')).toBeTruthy();
    const hh = backend.world.memberships.get(backend.world.currentUser!.id)!.householdId;
    expect(backend.world.server.list(hh).find((i) => i.name === 'Cadeautje oma')!.exclude_from_comparison).toBe(true);
  });

  it('empty list: "Nog niets te vergelijken"', async () => {
    await setup({ priceDataset: fixture() });
    await act(async () => fireEvent.press(await screen.findByLabelText('Prijzen vergelijken')));
    await flush();
    expect(screen.getByText('Nog niets te vergelijken')).toBeTruthy();
    expect(screen.getByLabelText('Naar Mijn lijst')).toBeTruthy();
  });

  it('speaks amounts in Dutch', () => {
    expect(speakCents(3842)).toBe('38 euro 42');
    expect(speakCents(500)).toBe('5 euro');
    expect(
      storeAccessibilityLabel(
        { chain_id: 'x', chain_name: 'Jumbo', complete: true, total_cents: 3842, delta_cents: null, priced_count: 12, compared_count: 12, stale_count: 1, label: 'cheapest', lines: [] },
        true,
      ),
    ).toBe('Jumbo, 12 van 12 prijzen, 1 verouderd, goedkoopste, 38 euro 42.');
  });
});
