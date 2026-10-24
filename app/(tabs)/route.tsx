import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

import { usePrices } from '@/src/features/route/PriceContext';
import { RouteScreen } from '@/src/features/route/RouteScreen';

/** "Goedkoopste route" (design-spec 4.5). Focus refreshes the prices quietly (rate limited). */
export default function RouteTab() {
  const { refresh } = usePrices();
  useFocusEffect(useCallback(() => refresh(), [refresh]));
  return <RouteScreen />;
}
