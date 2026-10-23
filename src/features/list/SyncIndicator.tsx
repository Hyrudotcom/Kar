import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { SyncStatus } from '@/src/contracts';
import { copyText } from '@/src/lib/share';
import { failedSummary } from '@/src/sync/failedText';
import { announce, AppText, BottomSheet, CloudOffIcon, IconButton, PrimaryButton, TextButton, WarningIcon } from '@/src/ui';
import { spacing } from '@/src/ui/tokens';

export type VisibleSyncState = 'idle' | 'offline' | 'error' | 'reauth';

export function visibleSyncState(s: SyncStatus): VisibleSyncState {
  if (s.icon === 'offline') return 'offline';
  if (s.needsReauth) return 'reauth';
  if (s.icon === 'error') return 'error';
  return 'idle';
}

export const OFFLINE_EXPLANATION = 'Je bent offline. Je wijzigingen worden bewaard en verstuurd zodra je weer verbinding hebt.';
export const REAUTH_EXPLANATION = 'Log opnieuw in om je wijzigingen te versturen.';

/**
 * Sync icon (design-spec 3 / 4.3): nothing normally (also while sending), a struck cloud offline,
 * ⚠ in danger on errors. A tap opens the explanation sheet. Announces only state transitions.
 */
export function SyncIndicator({
  status,
  onDiscard,
  failedText,
  onReauth,
}: {
  status: SyncStatus;
  onDiscard(ids: string[]): void;
  failedText(): string;
  onReauth(): void;
}) {
  const state = visibleSyncState(status);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const prev = useRef<VisibleSyncState>(state);

  useEffect(() => {
    if (prev.current === state) return;
    const was = prev.current;
    prev.current = state;
    if (state === 'offline') announce('Je bent offline');
    else if (state === 'error') announce('Een wijziging kon niet worden opgeslagen');
    else if (state === 'reauth') announce(REAUTH_EXPLANATION);
    else if (was === 'offline') announce('Weer online');
  }, [state]);

  if (state === 'idle') return null;
  const label = state === 'offline' ? 'Offline' : state === 'reauth' ? 'Opnieuw inloggen nodig' : 'Synchronisatiefout';
  return (
    <>
      <IconButton label={label} accessibilityHint="Toont uitleg" onPress={() => setOpen(true)} testID="sync-icon">
        {state === 'offline' ? <CloudOffIcon size={22} color="textMuted" /> : <WarningIcon size={22} color="danger" />}
      </IconButton>
      <BottomSheet visible={open} onClose={() => setOpen(false)} accessibilityLabel={label} testID="sync-sheet">
        {state === 'offline' ? (
          <AppText variant="body">{OFFLINE_EXPLANATION}</AppText>
        ) : state === 'reauth' ? (
          <View style={styles.gap}>
            <AppText variant="body">{REAUTH_EXPLANATION}</AppText>
            <PrimaryButton label="Opnieuw inloggen" onPress={onReauth} />
          </View>
        ) : (
          <View style={styles.gap}>
            <AppText variant="body">{failedSummary(status.failed)}</AppText>
            <View style={styles.actions}>
              <TextButton
                label={copied ? 'Gekopieerd' : 'Kopieer als tekst'}
                onPress={async () => {
                  setCopied(await copyText(failedText()));
                }}
              />
              <TextButton
                label="Weggooien"
                tone="danger"
                onPress={() => {
                  onDiscard(status.failed.map((f) => f.mutationId));
                  setOpen(false);
                }}
              />
            </View>
          </View>
        )}
      </BottomSheet>
    </>
  );
}

const styles = StyleSheet.create({
  gap: { gap: spacing.md },
  actions: { flexDirection: 'row', gap: spacing.xl },
});
