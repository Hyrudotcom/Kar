import { Tabs } from 'expo-router';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ListIcon, ReceiptIcon } from '@/src/ui';
import { useColors } from '@/src/ui/theme';
import { typography } from '@/src/ui/tokens';

/** Bar height above the bottom safe-area inset. */
const TAB_BAR_HEIGHT = 57;

/** Exactly two tabs (design-spec 3, TabBar). */
export default function TabLayout() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.textMuted,
        // The default bar (49 pt) is sized for 10 pt labels: with the app's footnote type (13 pt) the
        // label slot shrank to 10 pt and cut "Mijn lijst" in half (D2-01). 8 pt more makes room for a
        // 16 pt line under the 24 pt icon; the home indicator / gesture area comes on top.
        tabBarStyle: { backgroundColor: c.bg, borderTopColor: c.border, height: TAB_BAR_HEIGHT + insets.bottom },
        // The app's type scale (footnote 13) and the app's system font (D-04).
        tabBarLabelStyle: { fontSize: typography.footnote.fontSize, lineHeight: 16, fontWeight: '500', fontFamily: Platform.OS === 'web' ? 'System' : undefined },
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
