import { forwardRef, type ComponentRef } from 'react';
import { Platform, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { AppText } from './Text';
import { useColors } from './theme';
import { MAX_FONT_SCALE, radius, sizes, spacing, typography } from './tokens';

export interface TextFieldProps extends TextInputProps {
  /** Visible label above the field (also the accessibility label). */
  label?: string;
  error?: string | null;
  hint?: string | null;
}

/** Input on `surface`, 48 high (grows with text size), radius md. */
export const TextField = forwardRef<ComponentRef<typeof TextInput>, TextFieldProps>(function TextField({ label, error, hint, style, editable = true, ...rest }, ref) {
  const c = useColors();
  return (
    <View style={styles.wrap}>
      {label ? (
        <AppText variant="footnote" color="textMuted" style={styles.label}>
          {label}
        </AppText>
      ) : null}
      <TextInput
        ref={ref}
        accessibilityLabel={rest.accessibilityLabel ?? label}
        placeholderTextColor={c.textMuted}
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        editable={editable}
        {...rest}
        style={[
          styles.input,
          typography.body,
          { backgroundColor: c.surface, color: editable ? c.text : c.textMuted, borderColor: error ? c.danger : 'transparent' },
          // Visible keyboard focus in the accent colour instead of the browser default.
          Platform.OS === 'web' ? ({ outlineColor: c.accent } as object) : null,
          style,
        ]}
      />
      {error ? (
        <AppText variant="footnote" color="danger" accessibilityLiveRegion="polite" style={styles.below}>
          {error}
        </AppText>
      ) : hint ? (
        <AppText variant="footnote" color="textMuted" style={styles.below}>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  label: { marginBottom: 2 },
  input: {
    minHeight: sizes.inputHeight,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderWidth: 1,
  },
  below: { marginTop: 2 },
});
