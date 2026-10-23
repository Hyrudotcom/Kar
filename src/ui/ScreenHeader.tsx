import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText } from './Text';
import { sizes, spacing } from './tokens';

/**
 * The one-line header shared by both tabs: same height, padding and weight, so switching tabs never
 * moves the title (visual review D-05). Right-side buttons sit on the title line (D-06); an
 * optional subtitle goes on its own line below.
 */
export function ScreenHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <View>
      <View style={styles.row}>
        <AppText variant="body" accessibilityRole="header" numberOfLines={1} style={styles.title}>
          {title}
        </AppText>
        {right}
      </View>
      {subtitle ? (
        <AppText variant="footnote" color="textMuted" style={styles.subtitle}>
          {subtitle}
        </AppText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: sizes.minTouch + 4, paddingLeft: sizes.sideMargin, paddingRight: sizes.sideMargin - 12 },
  title: { flex: 1 },
  subtitle: { paddingHorizontal: sizes.sideMargin, marginTop: -spacing.xs, paddingBottom: spacing.sm },
});
