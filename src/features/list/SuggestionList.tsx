import { Pressable, StyleSheet, View } from 'react-native';

import type { ParsedEntry } from '@/src/contracts';
import { formatQuantity } from '@/src/shared/quantity';
import { AppText, PlusIcon, useColors } from '@/src/ui';
import { sizes, spacing } from '@/src/ui/tokens';

import type { Suggestion } from '../suggestions/search';

/** "+ ‘kaa’ toevoegen (2)" always on top, then at most 3 suggestions without icons or labels. */
export function SuggestionList({
  entry,
  suggestions,
  onAddTyped,
  onPick,
}: {
  entry: ParsedEntry;
  suggestions: Suggestion[];
  onAddTyped(): void;
  onPick(s: Suggestion): void;
}) {
  const c = useColors();
  const qty = entry.explicitQuantity ? formatQuantity(entry.quantity, entry.unit) || '1' : '';
  const addLabel = `‘${entry.name.toLocaleLowerCase('nl-NL')}’ toevoegen${qty ? ` (${qty})` : ''}`;
  return (
    <View style={[styles.wrap, { backgroundColor: c.bg }]} accessibilityRole="list" testID="suggestions">
      <Pressable
        onPress={onAddTyped}
        accessibilityRole="button"
        accessibilityLabel={addLabel}
        style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.surface : c.accentSoft }]}>
        <PlusIcon size={22} color="accent" />
        <AppText variant="body" style={styles.text}>
          {addLabel}
        </AppText>
      </Pressable>
      {suggestions.map((s) => (
        <Pressable
          key={s.key}
          onPress={() => onPick(s)}
          accessibilityRole="button"
          accessibilityLabel={`${s.name} toevoegen`}
          style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.surface : 'transparent' }]}>
          <View style={styles.iconSpace} />
          <AppText variant="body" style={styles.text}>
            {s.name}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingBottom: spacing.sm },
  // The "+" sits under the quick-add bar's "+" (16 margin + 1.5 border + 12), text on the rows' 56 pt inset (D3-13).
  row: { flexDirection: 'row', alignItems: 'center', minHeight: sizes.minTouch, paddingLeft: sizes.sideMargin + 14, paddingRight: sizes.sideMargin, gap: spacing.xs },
  iconSpace: { width: 22 },
  text: { flex: 1, paddingVertical: spacing.sm },
});
