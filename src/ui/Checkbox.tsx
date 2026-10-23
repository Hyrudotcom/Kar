import { Pressable, StyleSheet, View } from 'react-native';

import { CheckIcon } from './icons';
import { useColors } from './theme';
import { sizes } from './tokens';

/** Round checkbox, 24 pt visual, 48 pt tap zone (design-spec 2.3 / 3). */
export function Checkbox({
  checked,
  onToggle,
  label,
  accessible = true,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  /** false when a parent row already exposes the action to screen readers. */
  accessible?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onToggle}
      accessible={accessible}
      importantForAccessibility={accessible ? 'auto' : 'no'}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked }}
      testID="checkbox"
      style={styles.zone}>
      <View
        style={[
          styles.box,
          checked ? { backgroundColor: c.accent, borderColor: c.accent } : { borderColor: c.textMuted },
        ]}>
        {checked ? <CheckIcon size={18} color="onAccent" /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  zone: { width: sizes.minTouch, height: sizes.minTouch, alignItems: 'center', justifyContent: 'center' },
  box: {
    width: sizes.checkboxVisual,
    height: sizes.checkboxVisual,
    borderRadius: sizes.checkboxVisual / 2,
    borderWidth: 1.75,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
