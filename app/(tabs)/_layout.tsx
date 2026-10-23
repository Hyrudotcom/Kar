import { Tabs } from 'expo-router';

import { useColors } from '@/src/ui/theme';

/** Exactly two tabs (design-spec 3, TabBar). Icons are added by the mobile builder. */
export default function TabLayout() {
  const c = useColors();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.textMuted,
        tabBarStyle: { backgroundColor: c.bg, borderTopColor: c.border },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Mijn lijst' }} />
      <Tabs.Screen name="route" options={{ title: 'Goedkoopste route' }} />
    </Tabs>
  );
}
