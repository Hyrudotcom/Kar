import { screen } from '@testing-library/react-native';

import { RouteScreen } from '../route/RouteScreen';
import { makeBackend, renderReady, signIn } from './helpers';

jest.mock('react-native-safe-area-context', () => require('./mocks').safeAreaMock());
jest.mock('expo-router', () => ({ useRouter: () => require('./helpers').mockRouter }));

describe('scaffold smoke', () => {
  it('shows the honest v1 price state in Dutch', async () => {
    const backend = makeBackend();
    await signIn(backend);
    await renderReady(<RouteScreen />, backend);
    expect(await screen.findByText('Geen geverifieerde prijzen beschikbaar')).toBeTruthy();
  });
});
