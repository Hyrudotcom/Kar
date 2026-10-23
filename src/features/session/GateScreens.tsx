/** Full-screen session states: removed from household, first start offline, account switch. */
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { copyText } from '@/src/lib/share';
import { AppText, EmptyState, PrimaryButton, TextButton, useColors } from '@/src/ui';
import { sizes, spacing } from '@/src/ui/tokens';

import { InviteCodeSheet } from '../auth/InviteCodeSheet';
import { changesText } from './copy';
import { useSession } from './SessionProvider';

function Frame({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]}>
      <View style={styles.inner}>{children}</View>
    </SafeAreaView>
  );
}

/** "Je bent geen lid meer van Thuis" (design-spec 4.6, 5.8). Local data is already wiped. */
export function RemovedScreen() {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  if (session.state.kind !== 'removed') return null;
  const { householdName, failedCount, failedText } = session.state;
  const go = async () => {
    setBusy(true);
    await session.continueAfterRemoval();
    setBusy(false);
  };
  return (
    <Frame>
      <AppText variant="title" accessibilityRole="header" testID="removed-title">
        {`Je bent geen lid meer van ${householdName}`}
      </AppText>
      {failedCount > 0 ? (
        <View style={styles.gap}>
          <AppText variant="body" color="textMuted">
            {`${changesText(failedCount)} ${failedCount === 1 ? 'kon' : 'konden'} niet worden opgeslagen`}
          </AppText>
          <TextButton label={copied ? 'Gekopieerd' : 'Kopieer als tekst'} onPress={async () => setCopied(await copyText(failedText))} />
        </View>
      ) : null}
      <PrimaryButton label="Doorgaan" onPress={() => void go()} busy={busy} />
      <TextButton label="Ik heb een uitnodigingscode" onPress={() => setInviteOpen(true)} />
      {inviteOpen ? (
      <InviteCodeSheet
        visible
        onClose={() => setInviteOpen(false)}
        onCode={async (code) => {
          setInviteOpen(false);
          await session.setPendingInvite(code);
          await go();
        }}
      />
      ) : null}
    </Frame>
  );
}

/** First start without internet (design-spec 4.7). */
export function NoInternetScreen() {
  const session = useSession();
  return (
    <Frame>
      <EmptyState title="Geen internet" body="Inloggen en lid worden kan alleen online." action={{ label: 'Opnieuw proberen', onPress: () => void session.retry() }} actionStyle="primary" testID="no-internet" />
      <TextButton label="Uitloggen" tone="muted" align="center" onPress={() => void session.signOut(true)} />
    </Frame>
  );
}

/** Another account's unsent changes are on this phone (design-spec 5.10): explicit warning. */
export function SwitchAccountScreen() {
  const session = useSession();
  if (session.state.kind !== 'switchAccount') return null;
  const n = session.state.unsent;
  return (
    <Frame>
      <AppText variant="title" accessibilityRole="header">
        Ander account
      </AppText>
      <AppText variant="body" color="textMuted">
        {`Op deze telefoon staan nog ${changesText(n)} van een ander account die nog niet verstuurd zijn. Als je doorgaat, worden ze weggegooid.`}
      </AppText>
      <PrimaryButton label="Doorgaan en weggooien" onPress={() => void session.confirmSwitchAccount()} />
      <TextButton label="Terug naar inloggen" tone="muted" onPress={() => void session.cancelSwitchAccount()} />
    </Frame>
  );
}

/** Boot: nothing flashes; the splash background matches `bg`. */
export function BootScreen() {
  const c = useColors();
  return <View style={[styles.root, { backgroundColor: c.bg }]} testID="booting" />;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  inner: { flex: 1, justifyContent: 'center', paddingHorizontal: sizes.sideMargin + spacing.sm, gap: spacing.lg, maxWidth: 480, width: '100%', alignSelf: 'center' },
  gap: { gap: spacing.xs },
});
