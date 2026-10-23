import { memo, useLayoutEffect, useRef, useState } from 'react';
import { Animated, PanResponder, Platform, Pressable, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';

import type { VisibleItem } from '@/src/contracts';
import { formatQuantity, speakQuantity } from '@/src/shared/quantity';
import { AppText, Checkbox, useColors } from '@/src/ui';
import { sizes, spacing } from '@/src/ui/tokens';

export interface ListRowProps {
  item: VisibleItem;
  /** Shown struck through: the item is checked (it may still sit in the open section, waiting to settle). */
  onToggle(item: VisibleItem): void;
  onOpen(item: VisibleItem): void;
  onDelete(item: VisibleItem): void;
  onSwipeStart?(): void;
  onSwipeEnd?(): void;
}

/** "Melk, 2, halfvol. Niet afgevinkt." (design-spec 7). */
export function rowAccessibilityLabel(item: Pick<VisibleItem, 'name' | 'quantity' | 'unit' | 'note' | 'checked'>): string {
  const parts = [item.name];
  const q = speakQuantity(item.quantity, item.unit);
  if (q) parts.push(q);
  if (item.note.trim()) parts.push(item.note.trim());
  return `${parts.join(', ')}. ${item.checked ? 'Afgevinkt' : 'Niet afgevinkt'}.`;
}

const useNative = Platform.OS !== 'web';

/**
 * Checkbox, name, quantity as muted text, optional one-line note. Gestures: tap checkbox = check,
 * tap row = detail, swipe left = delete (with undo). Screen readers get the same as custom actions.
 */
function ListRowImpl({ item, onToggle, onOpen, onDelete, onSwipeStart, onSwipeEnd }: ListRowProps) {
  const c = useColors();
  const [tx] = useState(() => new Animated.Value(0));
  const width = useRef(360);
  const cb = useRef({ item, onDelete, onSwipeStart, onSwipeEnd });
  useLayoutEffect(() => {
    cb.current = { item, onDelete, onSwipeStart, onSwipeEnd };
  });

  // Refs are only read inside gesture callbacks, never during render.
  // eslint-disable-next-line react-hooks/refs
  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, g) => g.dx < -10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
      onPanResponderGrant: () => cb.current.onSwipeStart?.(),
      onPanResponderMove: (_, g) => tx.setValue(Math.min(0, g.dx)),
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_, g) => {
        cb.current.onSwipeEnd?.();
        const threshold = Math.min(120, width.current * 0.35);
        if (-g.dx > threshold || g.vx < -0.9) {
          Animated.timing(tx, { toValue: -width.current, duration: 150, useNativeDriver: useNative }).start(() => {
            cb.current.onDelete(cb.current.item);
            // If the delete is refused the row stays: bring it back.
            setTimeout(() => tx.setValue(0), 400);
          });
        } else {
          Animated.spring(tx, { toValue: 0, useNativeDriver: useNative, bounciness: 0 }).start();
        }
      },
      onPanResponderTerminate: () => {
        cb.current.onSwipeEnd?.();
        Animated.spring(tx, { toValue: 0, useNativeDriver: useNative, bounciness: 0 }).start();
      },
    }),
  );

  const qty = formatQuantity(item.quantity, item.unit);
  const note = item.note.trim();
  const checked = item.checked;

  const onAction = (e: AccessibilityActionEvent) => {
    switch (e.nativeEvent.actionName) {
      case 'toggle':
        onToggle(item);
        break;
      case 'activate':
      case 'details':
        onOpen(item);
        break;
      case 'delete':
        onDelete(item);
        break;
    }
  };

  return (
    <View
      style={styles.clip}
      onLayout={(e) => {
        width.current = e.nativeEvent.layout.width || width.current;
      }}>
      <View style={[StyleSheet.absoluteFill, styles.behind, { backgroundColor: c.dangerSoft }]} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <AppText variant="body" color="danger">
          Verwijderen
        </AppText>
      </View>
      <Animated.View
        {...pan.panHandlers}
        accessible
        accessibilityLabel={rowAccessibilityLabel(item)}
        accessibilityHint="Dubbeltik voor details."
        accessibilityActions={[
          { name: 'toggle', label: checked ? 'Vinkje weghalen' : 'Afvinken' },
          { name: 'details', label: 'Details' },
          { name: 'delete', label: 'Verwijderen' },
          { name: 'activate' },
        ]}
        onAccessibilityAction={onAction}
        testID={`row-${item.name}`}
        style={[styles.row, { backgroundColor: c.bg, borderBottomColor: c.border, transform: [{ translateX: tx }] }]}>
        <Checkbox checked={checked} onToggle={() => onToggle(item)} label={checked ? 'Vinkje weghalen' : 'Afvinken'} accessible={false} />
        <Pressable onPress={() => onOpen(item)} style={styles.body} importantForAccessibility="no" accessible={false} testID={`open-${item.name}`}>
          <AppText variant="body" color={checked ? 'textDisabled' : 'text'} strike={checked}>
            {item.name}
            {qty ? (
              <AppText variant="callout" color={checked ? 'textDisabled' : 'textMuted'}>
                {`  ${qty}`}
              </AppText>
            ) : null}
          </AppText>
          {note ? (
            <AppText variant="footnote" color={checked ? 'textDisabled' : 'textMuted'} numberOfLines={1}>
              {note}
            </AppText>
          ) : null}
        </Pressable>
      </Animated.View>
    </View>
  );
}

export const ListRow = memo(ListRowImpl);

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  behind: { alignItems: 'flex-end', justifyContent: 'center', paddingRight: sizes.sideMargin },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: sizes.rowMinHeight,
    paddingLeft: sizes.sideMargin - 12,
    paddingRight: sizes.sideMargin,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  body: { flex: 1, justifyContent: 'center', paddingVertical: spacing.sm, minHeight: sizes.rowMinHeight, paddingLeft: spacing.xs },
});
