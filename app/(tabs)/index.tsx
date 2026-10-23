import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useColors } from '@/src/ui/theme';
import { sizes, typography } from '@/src/ui/tokens';

/** Placeholder for "Mijn lijst" (design-spec 4.3). Replaced by the mobile builder. */
export default function MijnLijstScreen() {
  const c = useColors();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]} edges={['top']}>
      <View style={styles.empty}>
        <Text style={[typography.title, { color: c.text }]}>Je lijst is leeg</Text>
        <Text style={[typography.body, { color: c.textMuted }]}>Typ hierboven wat je nodig hebt.</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: sizes.sideMargin },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
});
