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
        <ChevronIcon size={24} direction={expanded ? 'down' : 'right'} color="textMuted" />
        <AppText variant="body" color="textMuted">{`Afgevinkt (${count})`}</AppText>
      </Pressable>
      <TextButton label="Wissen" onPress={onClear} accessibilityLabel="Afgevinkte items wissen" style={styles.clear} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: sizes.rowMinHeight, paddingHorizontal: sizes.sideMargin, borderBottomWidth: StyleSheet.hairlineWidth },
  // Chevron in the checkbox column (16..40), label on the rows' 56 pt text inset, "Wissen" ending on
  // the 16 pt margin like the quick-add bar (D3-13).
  toggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.lg, minHeight: sizes.minTouch },
  clear: { paddingLeft: spacing.sm },
});
