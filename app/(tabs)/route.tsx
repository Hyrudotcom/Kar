import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useColors } from '@/src/ui/theme';
import { sizes, typography } from '@/src/ui/tokens';

/** "Goedkoopste route" v1 state (design-spec 4.5, price verdict): no verified prices. */
export default function GoedkoopsteRouteScreen() {
  const c = useColors();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]} edges={['top']}>
      <Text style={[typography.body, { color: c.text }]}>Goedkoopste route</Text>
      <Text style={[typography.footnote, { color: c.textMuted }]}>
        Welke winkel is voor je hele lijst het goedkoopst
      </Text>
      <View style={styles.empty}>
        <Text style={[typography.title, { color: c.text }]}>Geen geverifieerde prijzen beschikbaar</Text>
        <Text style={[typography.body, { color: c.textMuted, textAlign: 'center' }]}>
          We laten liever niets zien dan een verkeerde vergelijking.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: sizes.sideMargin, paddingTop: 12 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
});
