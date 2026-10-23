import { forwardRef, useState, type ComponentRef } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';

import { CloseIcon, IconButton, PlusIcon, useColors } from '@/src/ui';
import { MAX_FONT_SCALE, radius, sizes, spacing, typography } from '@/src/ui/tokens';

export const QUICK_ADD_PLACEHOLDER = 'Voeg iets toe…';

/** Fixed above the list. Enter adds and keeps focus (design-spec 3). */
export const QuickAddBar = forwardRef<
  ComponentRef<typeof TextInput>,
  { value: string; onChangeText(t: string): void; onSubmit(): void; onFocus?(): void; onBlur?(): void }
>(function QuickAddBar({ value, onChangeText, onSubmit, onFocus, onBlur }, ref) {
  const c = useColors();
  const [focused, setFocused] = useState(false);
  return (
    // Focus is shown on the whole rounded bar (all platforms), not as a square ring around the input.
    <View style={[styles.bar, { backgroundColor: c.surface, borderColor: focused ? c.accent : 'transparent' }]}>
      <PlusIcon size={22} color="textMuted" style={styles.plus} />
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        onFocus={() => {
          setFocused(true);
          onFocus?.();
        }}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        submitBehavior="submit"
        returnKeyType="done"
        enterKeyHint="done"
        autoCapitalize="sentences"
        autoComplete="off"
        placeholder={QUICK_ADD_PLACEHOLDER}
        placeholderTextColor={c.textMuted}
        accessibilityLabel="Voeg iets toe"
        accessibilityHint="Typ bijvoorbeeld 2 melk of 500 g gehakt en druk op Enter."
        maxFontSizeMultiplier={MAX_FONT_SCALE}
        maxLength={140}
        testID="quick-add"
        style={[styles.input, typography.body, { color: c.text }, Platform.OS === 'web' ? ({ outlineStyle: 'none', outlineWidth: 0 } as object) : null]}
      />
      {value.length > 0 ? (
        <IconButton label="Tekst wissen" onPress={() => onChangeText('')}>
          <CloseIcon size={20} color="textMuted" />
        </IconButton>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: sizes.inputHeight,
    borderRadius: radius.md,
    borderWidth: 1.5,
    marginHorizontal: sizes.sideMargin,
    marginBottom: spacing.sm,
  },
  plus: { marginLeft: spacing.md },
  input: { flex: 1, minHeight: sizes.inputHeight, paddingHorizontal: spacing.sm, paddingVertical: spacing.md },
});
