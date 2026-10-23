import { render, screen } from '@testing-library/react-native';

import GoedkoopsteRouteScreen from '@/app/(tabs)/route';

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, SafeAreaProvider: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

describe('scaffold smoke', () => {
  it('shows the honest v1 price state in Dutch', async () => {
    await render(<GoedkoopsteRouteScreen />);
    expect(screen.getByText('Geen geverifieerde prijzen beschikbaar')).toBeTruthy();
  });
});
