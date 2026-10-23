import { Tabs } from 'expo-router';
import { Platform } from 'react-native';

import { ListIcon, ReceiptIcon } from '@/src/ui';
import { useColors } from '@/src/ui/theme';
import { typography } from '@/src/ui/tokens';

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
        // The app's type scale (smallest token: footnote 13) and the app's system font (D-04).
        tabBarLabelStyle: { ...typography.footnote, fontWeight: '500', fontFamily: Platform.OS === 'web' ? 'System' : undefined },
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
