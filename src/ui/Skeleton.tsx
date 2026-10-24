import { StyleSheet, View } from 'react-native';

import { useColors } from './theme';
import { sizes, spacing } from './tokens';

/** First load: 3 skeleton rows, no spinner (design-spec 4.7). */
export function SkeletonRows({ count = 3 }: { count?: number }) {
  const c = useColors();
  return (
    <View accessibilityLabel="Lijst laden" accessible testID="skeleton">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.row, { borderBottomColor: c.border }]}>
          <View style={[styles.dot, { backgroundColor: c.surface }]} />
          <View style={[styles.bar, { backgroundColor: c.surface, width: `${55 - i * 12}%` }]} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: sizes.rowMinHeight, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  dot: { width: sizes.checkboxVisual, height: sizes.checkboxVisual, borderRadius: sizes.checkboxVisual, marginLeft: 12 },
  bar: { height: 14, borderRadius: 7 },
});
