import type { ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { AppText } from './Text';
import { useColors } from './theme';
import { radius, sizes, spacing, type ColorToken } from './tokens';

/** Web only: the browser's own (orange) focus ring becomes an accent ring (D3-03). */
const focusRing = (accent: string): ViewStyle | null => (Platform.OS === 'web' ? { outlineColor: accent } : null);

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
        focusRing(c.accent),
        // Disabled reads as disabled in both themes (D3-05): a neutral fill, never a dimmed accent.
        disabled && !busy
          ? { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border }
          : { backgroundColor: c.accent, opacity: busy ? 0.7 : pressed ? 0.85 : 1 },
        style,
      ]}>
      {busy ? (
        <ActivityIndicator color={c.onAccent} />
      ) : (
        <AppText variant="bodyStrong" color={disabled ? 'textDisabled' : 'onAccent'} align="center">
          {label}
        </AppText>
      )}
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
        focusRing(c.accent),
        { borderWidth: 1, borderColor: c.border, backgroundColor: pressed ? c.surface : c.bg, opacity: inactive ? 0.5 : 1 },
        style,
      ]}>
      {busy ? <ActivityIndicator color={c.text} /> : <AppText variant="bodyStrong" align="center">{label}</AppText>}
    </Pressable>
  );
}

/**
 * Text-only button with a 48 pt touch target. tone: accent (default), danger, muted, text.
 * Body size is 500 weight; the smaller callout actions are 400, one weight per group (D4-07).
 */
export function TextButton({
  label,
  tone = 'accent',
  disabled,
  style,
  align = 'left',
  size = 'body',
  ...rest
}: BaseProps & { tone?: 'accent' | 'danger' | 'muted' | 'text'; align?: 'left' | 'center' | 'right'; size?: 'body' | 'callout' }) {
  const color: ColorToken = disabled ? 'textDisabled' : tone === 'muted' ? 'textMuted' : tone;
  const c = useColors();
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
        focusRing(c.accent),
        { alignItems: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start', opacity: pressed ? 0.6 : 1 },
        style,
      ]}>
      <AppText variant={size} color={color} style={size === 'body' && tone !== 'text' ? styles.textLabel : undefined}>
        {label}
      </AppText>
    </Pressable>
  );
}

/** Icon-only button; `label` is the accessibility label (never icon-only for screen readers). */
export function IconButton({ label, children, style, ...rest }: BaseProps & { children: ReactNode }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      {...rest}
      style={({ pressed }) => [styles.icon, focusRing(c.accent), { opacity: pressed ? 0.6 : 1 }, style]}>
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
