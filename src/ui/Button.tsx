import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { AppText } from './Text';
import { useColors } from './theme';
import { radius, sizes, spacing, type ColorToken } from './tokens';

interface BaseProps extends Omit<PressableProps, 'children' | 'style'> {
  label: string;
  style?: StyleProp<ViewStyle>;
}

/** Height 48, radius md. At most one per screen (design-spec 3). */
export function PrimaryButton({ label, disabled, busy, style, ...rest }: BaseProps & { busy?: boolean }) {
  const c = useColors();
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      {...rest}
      style={({ pressed }) => [
        styles.primary,
        { backgroundColor: c.accent, opacity: inactive ? 0.5 : pressed ? 0.85 : 1 },
        style,
      ]}>
      {busy ? <ActivityIndicator color={c.onAccent} /> : <AppText variant="bodyStrong" color="onAccent" align="center">{label}</AppText>}
    </Pressable>
  );
}

/** Outlined secondary button (e.g. "Doorgaan met Apple"), same size as the primary button. */
export function OutlineButton({ label, disabled, busy, style, ...rest }: BaseProps & { busy?: boolean }) {
  const c = useColors();
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!inactive, busy: !!busy }}
      disabled={inactive}
      {...rest}
      style={({ pressed }) => [
        styles.primary,
        { borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface : c.bg, opacity: inactive ? 0.5 : 1 },
        style,
      ]}>
      {busy ? <ActivityIndicator color={c.text} /> : <AppText variant="bodyStrong" align="center">{label}</AppText>}
    </Pressable>
  );
}

/** Text-only button with a 48 pt touch target. tone: accent (default), danger, muted. */
export function TextButton({
  label,
  tone = 'accent',
  disabled,
  style,
  align = 'left',
  ...rest
}: BaseProps & { tone?: 'accent' | 'danger' | 'muted' | 'text'; align?: 'left' | 'center' | 'right' }) {
  const color: ColorToken = disabled ? 'textDisabled' : tone === 'muted' ? 'textMuted' : tone;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={4}
      {...rest}
      style={({ pressed }) => [
        styles.text,
        { alignItems: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start', opacity: pressed ? 0.6 : 1 },
        style,
      ]}>
      <AppText variant="body" color={color} style={tone !== 'text' ? styles.textLabel : undefined}>
        {label}
      </AppText>
    </Pressable>
  );
}

/** Icon-only button; `label` is the accessibility label (never icon-only for screen readers). */
export function IconButton({ label, children, style, ...rest }: BaseProps & { children: ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      {...rest}
      style={({ pressed }) => [styles.icon, { opacity: pressed ? 0.6 : 1 }, style]}>
      <View pointerEvents="none">{children}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  primary: {
    minHeight: sizes.buttonHeight,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { minHeight: sizes.minTouch, justifyContent: 'center', paddingVertical: spacing.sm },
  textLabel: { fontWeight: '500' },
  icon: { width: sizes.minTouch, height: sizes.minTouch, alignItems: 'center', justifyContent: 'center' },
});
