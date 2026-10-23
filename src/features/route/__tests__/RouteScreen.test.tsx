import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { AppState } from 'react-native';

import type { ComparisonResult, PriceDataset } from '@/src/contracts';
import { DatasetBuilder } from '@/src/price/__tests__/fixtures';

import { flush, makeBackend, renderReady, signIn } from '../../__tests__/helpers';
import { PRICE_LOAD_TIMEOUT_MS, REFRESH_MIN_INTERVAL_MS, usePrices, type PriceState } from '../PriceContext';
import { isCachedComparisonUsable, RouteScreen, speakCents, storeAccessibilityLabel } from '../RouteScreen';

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
    expect(screen.getByText('Welke winkel is voor je hele lijst het goedkoopst?')).toBeTruthy();
    expect(screen.getByText(/We laten liever niets zien dan een verkeerde vergelijking\./)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText(/€/)).toBeNull();
  });

  it('price source unreachable without any earlier comparison (v1, offline start): still the calm "Geen geverifieerde prijzen", no error, no button', async () => {
    await setup({ priceError: true }, [{ name: 'Melk' }]);
    expect(await screen.findByText('Geen geverifieerde prijzen beschikbaar')).toBeTruthy();
    expect(screen.queryByText('Prijzen tijdelijk niet beschikbaar')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('a failed load is retried by itself when the connection comes back', async () => {
    const backend = makeBackend({ priceDataset: fixture() });
    const me = await signIn(backend);
    const r = await backend.households.createHousehold();
    if (!r.ok) throw new Error('hh');
    backend.world.addItemsAs(me.id, r.household.id, [{ name: 'Melk' }]);
    const load = backend.prices.loadDataset;
    let fail = true;
    backend.prices.loadDataset = async (id) => {
      if (fail) throw new Error('unreachable');
      return load(id);
    };
    await renderReady(<RouteScreen />, backend);
    expect(await screen.findByText('Geen geverifieerde prijzen beschikbaar')).toBeTruthy();
    fail = false;
    await act(async () => {
      backend.connectivity.set(false);
      backend.connectivity.set(true);
    });
    await flush();
    expect(await screen.findByLabelText('Prijzen vergelijken')).toBeTruthy();
  });

  it('cached comparisons are only reused while still true (age, 7/14-day rules, promotions)', () => {
    const now = Date.now();
    const H = 3_600_000;
    const line = (status: string, observedDaysAgo: number, extra: object = {}) => ({
      status,
      age_days: Math.floor(observedDaysAgo),
      observed_at: new Date(now - observedDaysAgo * DAY).toISOString(),
      promotion_applied: false,
      promotion_valid_until: null,
      ...extra,
    });
    const res = (...lines: object[]) => ({ stores: [{ lines }] }) as unknown as ComparisonResult;
    // Ages are judged at "now" from the exact observation time, not from the cached whole days.
    expect(isCachedComparisonUsable(res(line('stale', 13)), now - 60_000, now)).toBe(true);
    expect(isCachedComparisonUsable(res(line('stale', 13)), now - 13 * H, now)).toBe(false); // older than 12 h
    // Regression: cached 11 h ago at 13.9 - 11/24 d (floored to 13): now 13.9 d, still stale -> usable;
    // at 14.05 d it is unknown now -> the cached total and "Goedkoopste" may not be shown.
    expect(isCachedComparisonUsable(res(line('stale', 13.9)), now - 11 * H, now)).toBe(true);
    expect(isCachedComparisonUsable(res(line('stale', 14.05)), now - 11 * H, now)).toBe(false);
    // A line cached as verified that has meanwhile passed 7 days would now be "verouderd".
    expect(isCachedComparisonUsable(res(line('verified', 7.2)), now - 11 * H, now)).toBe(false);
    expect(isCachedComparisonUsable(res(line('verified', 6.5)), now - 11 * H, now)).toBe(true);
    // A cache without observed_at (older app version) uses the upper bound of its floored age.
    const legacy = { stores: [{ lines: [{ status: 'stale', age_days: 13, promotion_applied: false, promotion_valid_until: null }] }] } as unknown as ComparisonResult;
    expect(isCachedComparisonUsable(legacy, now - 60_000, now)).toBe(false);
    expect(isCachedComparisonUsable(res(line('verified', 1, { promotion_applied: true, promotion_valid_until: new Date(now - 1000).toISOString() })), now - 60_000, now)).toBe(false);
  });

  it('a stalled price request (never answers) never leaves skeleton rows: "Geen geverifieerde prijzen" shows at once', async () => {
    const backend = makeBackend({ priceDataset: fixture() });
    const me = await signIn(backend);
    const r = await backend.households.createHousehold();
    if (!r.ok) throw new Error('hh');
    backend.world.addItemsAs(me.id, r.household.id, [{ name: 'Melk' }]);
    const getOptIn = jest.fn(() => new Promise<boolean>(() => undefined));
    backend.prices.loadDataset = () => new Promise<PriceDataset>(() => undefined);
    backend.prices.getOptIn = getOptIn;
    await renderReady(<RouteScreen />, backend);
    await flush();
    expect(screen.getByTestId('route-unavailable')).toBeTruthy();
    expect(getOptIn).not.toHaveBeenCalled(); // opt-in is only fetched once a comparison is possible
  });

  it('when this device saw verified prices before, a stalled load ends after the timeout instead of loading forever', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      const backend = makeBackend({ priceDataset: fixture() });
      const me = await signIn(backend);
      const r = await backend.households.createHousehold();
      if (!r.ok) throw new Error('hh');
      await backend.kv.setItem(`price_available_${r.household.id}`, '1');
      backend.world.addItemsAs(me.id, r.household.id, [{ name: 'Melk' }]);
      backend.prices.loadDataset = () => new Promise<PriceDataset>(() => undefined);
      await renderReady(<RouteScreen />, backend);
      await flush();
      expect(screen.queryByTestId('route-unavailable')).toBeNull(); // skeleton while it may still come
      await act(async () => {
        jest.advanceTimersByTime(PRICE_LOAD_TIMEOUT_MS + 10);
      });
      await flush();
      expect(screen.getByTestId('route-unavailable')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('equal totals: both stores read "Even goedkoop", no single "Goedkoopste", no +€0,00', async () => {
    const b = new DatasetBuilder();
    b.data.chains = [
      { id: 'ah', name: 'Albert Heijn' },
      { id: 'jumbo', name: 'Jumbo' },
    ];
    b.catalog('melk', ['melk'], 1000, 'ml');
    b.simple('melk', 'ah', 119, 1000, 'ml', ago(1));
    b.simple('melk', 'jumbo', 119, 1000, 'ml', ago(1));
    await setup({ priceDataset: b.data }, [{ name: 'Melk' }]);
    await act(async () => fireEvent.press(await screen.findByLabelText('Prijzen vergelijken')));
    await flush();
    expect(within(screen.getByTestId('store-ah')).getByText('Even goedkoop')).toBeTruthy();
    expect(within(screen.getByTestId('store-jumbo')).getByText('Even goedkoop')).toBeTruthy();
    expect(screen.queryByText('Goedkoopste')).toBeNull();
    expect(screen.queryByText('+€0,00')).toBeNull();
  });

  it('with verified data: opt-in first, then only complete baskets are ranked and totalled', async () => {
    const backend = await setup({ priceDataset: fixture() }, [{ name: 'Melk', quantity: 2 }, { name: 'Brood' }]);
    expect(await screen.findByText('Vergelijk je lijst per winkel')).toBeTruthy();
    expect(screen.getByText('We tellen per winkel je hele lijst op, met prijzen van Testfeed. Ontbrekende prijzen tonen we eerlijk.')).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByLabelText('Prijzen vergelijken')));
    await flush();
    expect(backend.world.optIn.get(backend.world.currentUser!.id)).toBe(true);

    expect(screen.getByText('2 producten · oudste prijs 9 dagen oud')).toBeTruthy();
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
    expect(screen.getByText('Dit zijn webshopprijzen. In de winkel kan het anders zijn.')).toBeTruthy();

    // Lines of the incomplete store: the unknown price is "Geen prijs", never €0,00.
    await act(async () => fireEvent.press(lidl));
    const sheet = screen.getByTestId('store-sheet');
    expect(within(sheet).getByText('Onvolledig · 1 van 2 prijzen')).toBeTruthy(); // D-14
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

  it('round 4: another member\'s "Verkeerd product" reaches this phone on foreground, without a restart', async () => {
    const handlers: ((s: string) => void)[] = [];
    const orig = AppState.addEventListener;
    AppState.addEventListener = ((type: string, h: (s: string) => void) => {
      if (type === 'change') handlers.push(h);
      return { remove: () => undefined };
    }) as unknown as typeof orig;
    try {
      const backend = await setup({ priceDataset: fixture() }, [{ name: 'Melk', quantity: 2 }, { name: 'Brood' }]);
      await act(async () => fireEvent.press(await screen.findByLabelText('Prijzen vergelijken')));
      await flush();
      expect(within(screen.getByTestId('store-jumbo')).getByText('Goedkoopste · 1 verouderd')).toBeTruthy();
      const hh = backend.world.memberships.get(backend.world.currentUser!.id)!.householdId;
      // Sanne, on her own phone, marks Jumbo's melk as the wrong product.
      backend.world.overrides.push({ household_id: hh, catalog_item_id: 'melk', chain_id: 'jumbo', created_by: null, created_at: new Date().toISOString() });
      // Within the minimum interval nothing is reloaded.
      await act(async () => handlers.forEach((h) => h('active')));
      await flush();
      expect(within(screen.getByTestId('store-jumbo')).getByText('Goedkoopste · 1 verouderd')).toBeTruthy();
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now + REFRESH_MIN_INTERVAL_MS + 1);
      try {
        await act(async () => handlers.forEach((h) => h('active')));
        await flush();
      } finally {
        clock.mockRestore();
      }
      expect(within(screen.getByTestId('store-jumbo')).getByText('1 van 2 prijzen')).toBeTruthy();
      expect(within(screen.getByTestId('store-ah')).getByText('Enige complete mand')).toBeTruthy();
    } finally {
      AppState.addEventListener = orig;
    }
  });

  it('no complete basket: "Geen winkel heeft al je prijzen" and "Niet vergelijken" for items without any price', async () => {
    const backend = await setup({ priceDataset: fixture() }, [{ name: 'Melk' }, { name: 'Cadeautje oma' }]);
    await act(async () => fireEvent.press(await screen.findByLabelText('Prijzen vergelijken')));
    await flush();
    expect(screen.getByText('Geen winkel heeft al je prijzen')).toBeTruthy();
    expect(screen.queryByText(/^€/)).toBeNull();
    await act(async () => fireEvent.press(screen.getByLabelText('Cadeautje oma niet vergelijken')));
    await flush();
    expect(screen.getByText('1 van 2 producten vergeleken · 1 uitgesloten · oudste prijs 9 dagen oud')).toBeTruthy();
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

  it('round 3: all items on "Niet vergelijken" still shows them with "Toch vergelijken"', async () => {
    await setup({ priceDataset: fixture() }, [{ name: 'Cadeautje oma' }]);
    await act(async () => fireEvent.press(await screen.findByLabelText('Prijzen vergelijken')));
    await flush();
    await act(async () => fireEvent.press(screen.getByLabelText('Cadeautje oma niet vergelijken')));
    await flush();
    expect(screen.queryByText('Nog niets te vergelijken')).toBeNull();
    await act(async () => fireEvent.press(screen.getByLabelText('Cadeautje oma toch vergelijken')));
    await flush();
    expect(screen.getByLabelText('Cadeautje oma niet vergelijken')).toBeTruthy();
  });

  it('round 3: an offline cached comparison names the channel of the prices it shows', async () => {
    const backend = makeBackend({ priceDataset: fixture() });
    const me = await signIn(backend);
    const r = await backend.households.createHousehold();
    if (!r.ok) throw new Error('hh');
    backend.world.addItemsAs(me.id, r.household.id, [{ name: 'Melk' }, { name: 'Brood' }]);
    let prices: PriceState | null = null;
    function Grab() {
      prices = usePrices();
      return null;
    }
    await renderReady(
      <>
        <RouteScreen />
        <Grab />
      </>,
      backend,
    );
    await act(async () => fireEvent.press(await screen.findByLabelText('Prijzen vergelijken')));
    await flush();
    expect(screen.getByText('Dit zijn webshopprijzen. In de winkel kan het anders zijn.')).toBeTruthy();
    await flush(20); // cache written
    backend.prices.loadDataset = async () => {
      throw new Error('offline');
    };
    await act(async () => prices!.reload());
    await flush(20);
    expect(screen.getByTestId('route-result')).toBeTruthy();
    expect(screen.getByText('Dit zijn webshopprijzen. In de winkel kan het anders zijn.')).toBeTruthy();
    expect(screen.queryByText(/landelijke prijzen/)).toBeNull();
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
