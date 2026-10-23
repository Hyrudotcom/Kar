import { Pressable, StyleSheet, View } from 'react-native';

import { AppText, ChevronIcon, TextButton, useColors } from '@/src/ui';
import { sizes, spacing } from '@/src/ui/tokens';

/** "Afgevinkt (n)", collapsible (collapsed by default), with one text button "Wissen" (design-spec 3). */
export function CheckedHeader({ count, expanded, onToggle, onClear }: { count: number; expanded: boolean; onToggle(): void; onClear(): void }) {
  const c = useColors();
  return (
    <View style={[styles.row, { borderBottomColor: c.border }]}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`Afgevinkt, ${count} ${count === 1 ? 'item' : 'items'}`}
        accessibilityState={{ expanded }}
        testID="checked-toggle"
        style={styles.toggle}>
        <ChevronIcon size={20} direction={expanded ? 'down' : 'right'} color="textMuted" />
        <AppText variant="body" color="textMuted">{`Afgevinkt (${count})`}</AppText>
      </Pressable>
      <TextButton label="Wissen" onPress={onClear} accessibilityLabel="Afgevinkte items wissen" style={styles.clear} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: sizes.rowMinHeight, paddingHorizontal: sizes.sideMargin, borderBottomWidth: StyleSheet.hairlineWidth },
  toggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: sizes.minTouch },
  clear: { paddingHorizontal: spacing.sm },
});
