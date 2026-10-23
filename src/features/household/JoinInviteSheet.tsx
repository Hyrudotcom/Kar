/**
 * "Word je lid van …?" (design-spec 4.2). A link never adds you without this tap.
 * Closing (swipe down / tap outside) cancels and forgets the code, except after a transient error
 * (no internet, server): then the code is kept, the preview is fetched again when the connection
 * comes back (or on "Opnieuw proberen"), and the sheet returns once it loads.
 */
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { PreviewInviteResult } from '@/src/contracts';
import { AppText, BottomSheet, PrimaryButton, TextButton } from '@/src/ui';
import { spacing } from '@/src/ui/tokens';

import { useSnackbar } from '../feedback/SnackbarProvider';
import { useBackend } from '../session/BackendContext';
import { householdErrorText, OFFLINE_JOIN, unsentTitle } from '../session/copy';
import { useSession } from '../session/SessionProvider';

type Preview = Extract<PreviewInviteResult, { ok: true }>;

/** "Word je lid van ‘Thuis’?"; "… ‘Thuis’ van Jan?" when the joiner's own household has the same name. */
export function joinTitle(preview: Pick<Preview, 'household_name' | 'inviter_name'>, currentName: string | null): string {
  const same = !!currentName && currentName.trim().toLocaleLowerCase('nl-NL') === preview.household_name.trim().toLocaleLowerCase('nl-NL');
  const of = same && preview.inviter_name ? ` van ${preview.inviter_name}` : '';
  return `Word je lid van ‘${preview.household_name}’${of}?`;
}

export function JoinInviteSheet() {
  const session = useSession();
  const backend = useBackend();
  const snackbar = useSnackbar();
  const code = session.state.kind === 'ready' ? session.pendingInvite : null;
  const currentName = session.state.kind === 'ready' ? session.state.household.name : 'Thuis';
  const [result, setResult] = useState<{ code: string; preview: Preview | null; error: string | null; transient?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** A transient error the user swiped away: hidden, but the code is kept. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Unsent changes that a forced drain could not deliver: ask before joining anyway. */
  const [pending, setPending] = useState<number | null>(null);
  const current = result && result.code === code ? result : null;
  const preview = current?.preview ?? null;
  const error = current?.error ?? null;
  const transient = !preview && !!current?.transient;
  const setError = (e: string | null) => code && setResult({ code, preview, error: e });

  useEffect(() => {
    if (!code) return;
    let alive = true;
    void backend.households.previewInvite(code).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setResult({ code, preview: r, error: null });
        setDismissed(null);
      } else {
        const isTransient = r.error === 'network' || r.error === 'server' || r.error === 'rate_limited';
        setResult({ code, preview: null, error: householdErrorText(r.error, currentName, OFFLINE_JOIN), transient: isTransient });
      }
    });
    return () => {
      alive = false;
    };
    // currentName only matters for the error text of this preview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, backend, attempt]);

  // Back online after a transient error: fetch the preview again by itself.
  const retryOnline = !!code && transient;
  useEffect(() => {
    if (!retryOnline) return;
    return backend.connectivity.subscribe((online) => {
      if (online) setAttempt((n) => n + 1);
    });
  }, [backend, retryOnline]);

  const close = () => {
    if (transient && code) setDismissed(code);
    else void session.setPendingInvite(null);
  };

  const join = async (force = false) => {
    if (!code || !preview) return;
    setBusy(true);
    const r = await session.acceptInvite(code, force);
    setBusy(false);
    if (r.ok) {
      setPending(null);
      snackbar.show({ message: `Je bent lid van ${preview.household_name}` });
    } else if (r.error === 'pending' && r.pending) {
      setPending(r.pending);
    } else {
      setError(householdErrorText(r.error, currentName, OFFLINE_JOIN));
    }
  };

  // The inviter is named once: in the title when it says "‘Thuis’ van Jan", else in the subtitle (D2-09).
  const title = preview ? joinTitle(preview, session.state.kind === 'ready' ? currentName : null) : '';
  return (
    <BottomSheet visible={!!code && (!!preview || (!!error && dismissed !== code))} onClose={close} testID="join-sheet" accessibilityLabel="Uitnodiging">
      {preview ? (
        <View style={styles.gap}>
          <AppText variant="title" accessibilityRole="header">
            {title}
          </AppText>
          <AppText variant="callout" color="textMuted">
            {[preview.inviter_name && !title.endsWith(` van ${preview.inviter_name}?`) ? `Uitgenodigd door ${preview.inviter_name}` : null, `${preview.member_count} ${preview.member_count === 1 ? 'lid' : 'leden'}`].filter(Boolean).join(' · ')}
          </AppText>
          {preview.leaves_current_household ? (
            <AppText variant="callout">{`Je verlaat dan ${preview.current_household_name ?? currentName}.`}</AppText>
          ) : null}
          {error ? (
            <AppText variant="callout" color="danger" accessibilityLiveRegion="polite">
              {error}
            </AppText>
          ) : null}
          {pending ? (
            <>
              <AppText variant="callout" testID="join-pending">{`${unsentTitle(pending)} Die gaan verloren als je nu lid wordt.`}</AppText>
              <PrimaryButton label="Toch lid worden" onPress={() => void join(true)} busy={busy} />
            </>
          ) : (
            <PrimaryButton label="Lid worden" onPress={() => void join()} busy={busy} />
          )}
        </View>
      ) : error ? (
        <View style={styles.gap}>
          <AppText variant="title" accessibilityRole="header">
            Uitnodiging
          </AppText>
          <AppText variant="body" accessibilityLiveRegion="polite" testID="join-error">
            {error}
          </AppText>
          {transient ? <PrimaryButton label="Opnieuw proberen" onPress={() => setAttempt((n) => n + 1)} /> : null}
          {transient ? <TextButton label="Annuleren" tone="muted" align="center" onPress={() => void session.setPendingInvite(null)} /> : null}
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({ gap: { gap: spacing.md } });
