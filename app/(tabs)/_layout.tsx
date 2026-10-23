import { Tabs } from 'expo-router';

import { ListIcon, ReceiptIcon } from '@/src/ui';
import { useColors } from '@/src/ui/theme';

/** Exactly two tabs (design-spec 3, TabBar). */
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
      <Tabs.Screen
        name="index"
        options={{
          title: 'Mijn lijst',
          tabBarAccessibilityLabel: 'Mijn lijst',
          tabBarIcon: ({ focused }) => <ListIcon size={24} color={focused ? 'accent' : 'textMuted'} />,
        }}
      />
      <Tabs.Screen
        name="route"
        options={{
          title: 'Goedkoopste route',
          tabBarAccessibilityLabel: 'Goedkoopste route',
          tabBarIcon: ({ focused }) => <ReceiptIcon size={24} color={focused ? 'accent' : 'textMuted'} />,
        }}
      />
    </Tabs>
  );
}
