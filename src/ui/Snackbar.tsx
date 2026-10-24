import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from './Text';
import { useColors, useScheme } from './theme';
import { radius, sizes, spacing } from './tokens';

/**
 * Presentational undo snackbar: one message, at most one action ("Ongedaan maken").
 * Timing, aggregation and announcements live in the SnackbarProvider (src/features/feedback).
 */
export function Snackbar({ message, actionLabel, onAction }: { message: string; actionLabel?: string; onAction?: () => void }) {
  const c = useColors();
  const scheme = useScheme();
  // Inverted surface so it reads as transient and stands out in both themes.
  const bg = scheme === 'dark' ? c.surfaceRaised : c.text;
  const fg = scheme === 'dark' ? 'text' : 'bg';
  return (
    <View style={[styles.bar, { backgroundColor: bg, borderColor: c.border }]} accessibilityLiveRegion="polite" testID="snackbar">
      <AppText variant="callout" color={fg} style={styles.message}>
        {message}
      </AppText>
      {actionLabel && onAction ? (
        <Pressable accessibilityRole="button" accessibilityLabel={actionLabel} onPress={onAction} hitSlop={8} style={styles.action}>
          <AppText variant="callout" color={scheme === 'dark' ? 'accent' : 'accentSoft'} style={styles.actionText}>
            {actionLabel}
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    minHeight: sizes.minTouch,
    borderWidth: StyleSheet.hairlineWidth,
  },
  message: { flex: 1, paddingVertical: spacing.md },
  action: { minHeight: sizes.minTouch, justifyContent: 'center', paddingHorizontal: spacing.md },
  actionText: { fontWeight: '600' },
});
