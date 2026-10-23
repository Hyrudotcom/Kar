import { StyleSheet, View } from 'react-native';

import { PrimaryButton } from './Button';
import { BottomSheet } from './BottomSheet';
import { AppText } from './Text';
import { useColors } from './theme';
import { spacing } from './tokens';

/**
 * Confirmation as a bottom sheet (no system alert, works the same on web): one sentence and one
 * action, as in design-spec 4.6. Dismiss = cancel (swipe down, tap outside, screen-reader "Sluiten").
 */
export function ConfirmSheet({
  visible,
  title,
  body,
  confirmLabel,
  danger,
  busy,
  error,
  onConfirm,
  onCancel,
  testID,
}: {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm(): void;
  onCancel(): void;
  testID?: string;
}) {
  const c = useColors();
  return (
    <BottomSheet visible={visible} onClose={onCancel} title={title} testID={testID}>
      <View style={styles.body}>
        {body ? <AppText variant="body" color="textMuted">{body}</AppText> : null}
        {error ? (
          <AppText variant="callout" color="danger" accessibilityLiveRegion="polite">
            {error}
          </AppText>
        ) : null}
        <PrimaryButton label={confirmLabel} onPress={onConfirm} busy={busy} style={danger ? { backgroundColor: c.danger } : undefined} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({ body: { gap: spacing.md } });
