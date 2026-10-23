import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { PrimaryButton, TextButton } from './Button';
import { AppText } from './Text';
import { spacing } from './tokens';

/** Line icon, title, one sentence, at most one button (design-spec 3). */
export function EmptyState({
  icon,
  title,
  body,
  action,
  actionStyle = 'text',
  testID,
}: {
  icon?: ReactNode;
  title?: string;
  body?: string;
  action?: { label: string; onPress: () => void };
  actionStyle?: 'primary' | 'text';
  testID?: string;
}) {
  return (
    <View style={styles.root} testID={testID}>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      {title ? (
        <AppText variant="title" align="center" accessibilityRole="header">
          {title}
        </AppText>
      ) : null}
      {body ? (
        <AppText variant="callout" color="textMuted" align="center" style={styles.body}>
          {body}
        </AppText>
      ) : null}
      {action ? (
        actionStyle === 'primary' ? (
          <PrimaryButton label={action.label} onPress={action.onPress} style={styles.primary} />
        ) : (
          <TextButton label={action.label} onPress={action.onPress} align="center" />
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingHorizontal: spacing.xl, paddingVertical: spacing.xxl },
  icon: { marginBottom: spacing.sm },
  body: { maxWidth: 300 },
  primary: { alignSelf: 'stretch', marginTop: spacing.md },
});
