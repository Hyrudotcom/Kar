import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, PrimaryButton, TextField } from '@/src/ui';
import { spacing } from '@/src/ui/tokens';

import { normalizeInviteCode } from '../session/SessionProvider';

/** "Ik heb een uitnodigingscode": type the 6-character code (design-spec 4.2). Mount it only while open. */
export function InviteCodeSheet({ visible, onClose, onCode }: { visible: boolean; onClose(): void; onCode(code: string): void | Promise<void> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const code = normalizeInviteCode(value);
    if (!code) {
      setError('Een code heeft 6 tekens, bijvoorbeeld K7QM4Z.');
      return;
    }
    void onCode(code);
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Uitnodigingscode" testID="invite-code-sheet">
      <View style={styles.gap}>
        <TextField
          accessibilityLabel="Uitnodigingscode"
          value={value}
          onChangeText={(t) => {
            setValue(t.toUpperCase());
            if (error) setError(null);
          }}
          onSubmitEditing={submit}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          maxLength={8}
          placeholder="6 tekens"
          error={error}
          autoFocus
          testID="invite-code-input"
        />
        <PrimaryButton label="Doorgaan" onPress={submit} disabled={value.replace(/[\s-]/g, '').length < 6} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({ gap: { gap: spacing.md } });
