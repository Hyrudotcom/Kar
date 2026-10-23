/**
 * Huishouden (design-spec 4.6): share, name (owner only), members, price toggle, account.
 * Roles v1: exactly one owner (the creator). Everyone edits and shares; only the owner removes
 * members, renames and replaces the code.
 */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LIMITS, type HouseholdMember } from '@/src/contracts';
import { inviteMessage, shareText } from '@/src/lib/share';
import { AppText, ChevronIcon, ConfirmSheet, IconButton, PrimaryButton, TextButton, TextField, useColors } from '@/src/ui';
import { sizes, spacing } from '@/src/ui/tokens';

import { useSnackbar } from '../feedback/SnackbarProvider';
import { usePrices } from '../route/PriceContext';
import { useBackend } from '../session/BackendContext';
import { changesText, householdErrorText, OFFLINE_SHARE } from '../session/copy';
import { useReadySession, type ActionResult } from '../session/SessionProvider';

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toLocaleUpperCase('nl-NL');
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toLocaleUpperCase('nl-NL');
}

type Confirm =
  | { kind: 'remove'; member: HouseholdMember }
  | { kind: 'leave' }
  | { kind: 'leavePending'; pending: number }
  | { kind: 'signOutPending'; pending: number }
  | { kind: 'deleteAccount' }
  | { kind: 'replaceCode' };

export function HouseholdScreen() {
  const c = useColors();
  const router = useRouter();
  const backend = useBackend();
  const snackbar = useSnackbar();
  const prices = usePrices();
  const { user, household, session } = useReadySession();
  const isOwner = household.role === 'owner';
  /** null while not editing: the field shows the current name (also after renames by others). */
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const name = nameDraft ?? household.name;
  const [nameError, setNameError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [online, setOnline] = useState(backend.connectivity.isOnline());

  useEffect(() => backend.connectivity.subscribe(setOnline), [backend]);
  useEffect(() => {
    void session.refreshHousehold();
    // Only on open; later refreshes come from foregrounding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const members = household.members.length
    ? household.members
    : [{ household_id: household.id, user_id: user.id, role: household.role, joined_at: '', display_name: user.displayName }];
  const alone = members.length <= 1;

  const share = async (replace: boolean) => {
    setSharing(true);
    const r = await backend.households.createInvite(household.id, replace);
    setSharing(false);
    if (!r.ok) {
      snackbar.show({ message: r.error === 'network' ? OFFLINE_SHARE : householdErrorText(r.error, household.name) });
      return;
    }
    setCode(r.code);
    if (replace) {
      snackbar.show({ message: `Nieuwe code: ${r.code}. De oude code werkt niet meer.` });
      return;
    }
    const outcome = await shareText(inviteMessage(r.url, r.code));
    if (outcome === 'copied') snackbar.show({ message: 'Uitnodiging gekopieerd' });
    else if (outcome === 'failed') snackbar.show({ message: `Code: ${r.code}` });
  };

  const rename = async () => {
    const n = name.trim();
    if (n === household.name) {
      setNameDraft(null);
      return;
    }
    if (n.length < 1 || n.length > LIMITS.householdNameMaxLength) {
      setNameError(householdErrorText('invalid'));
      return;
    }
    const r = await backend.households.renameHousehold(household.id, n);
    if (!r.ok) {
      setNameError(householdErrorText(r.error, household.name));
      return;
    }
    setNameError(null);
    setNameDraft(null);
    void session.refreshHousehold();
  };

  const finish = useCallback(
    (r: ActionResult, onPending?: (n: number) => Confirm) => {
      if (r.ok) {
        setConfirm(null);
        return true;
      }
      if (r.error === 'pending' && r.pending && onPending) {
        setConfirm(onPending(r.pending));
        return false;
      }
      setConfirmError(householdErrorText(r.error, household.name));
      return false;
    },
    [household.name],
  );

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    setConfirmError(null);
    const hhName = household.name;
    try {
      switch (confirm.kind) {
        case 'remove': {
          const r = await backend.households.removeMember(household.id, confirm.member.user_id);
          if (!r.ok) setConfirmError(householdErrorText(r.error, hhName));
          else {
            setConfirm(null);
            setCode(null);
            snackbar.show({ message: `${confirm.member.display_name || 'Lid'} is verwijderd uit ${hhName}` });
            void session.refreshHousehold();
          }
          break;
        }
        case 'leave':
        case 'leavePending': {
          const r = await session.leaveHousehold(confirm.kind === 'leavePending');
          if (finish(r, (pending) => ({ kind: 'leavePending', pending }))) {
            router.navigate('/');
            snackbar.show({ message: `Je hebt ${hhName} verlaten` });
          }
          break;
        }
        case 'signOutPending':
          finish(await session.signOut(true));
          break;
        case 'deleteAccount':
          finish(await session.deleteAccount());
          break;
        case 'replaceCode':
          setConfirm(null);
          await share(true);
          break;
      }
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    const r = await session.signOut(false);
    if (!r.ok && r.error === 'pending' && r.pending) setConfirm({ kind: 'signOutPending', pending: r.pending });
  };

  const confirmProps = (() => {
    if (!confirm) return null;
    const hh = household.name;
    switch (confirm.kind) {
      case 'remove':
        return { title: `${confirm.member.display_name || 'Dit lid'} verwijderen uit ${hh}?`, body: 'De uitnodigingscode wordt ook vervangen.', confirmLabel: 'Verwijderen' };
      case 'leave':
        return alone
          ? { title: `${hh} verlaten?`, body: `${hh} en de lijst worden definitief verwijderd.`, confirmLabel: 'Verwijderen' }
          : { title: `${hh} verlaten?`, body: 'Je ziet deze lijst daarna niet meer.', confirmLabel: 'Verlaten' };
      case 'leavePending':
        return { title: `Je hebt ${changesText(confirm.pending)} die nog niet verstuurd zijn.`, confirmLabel: 'Toch verlaten' };
      case 'signOutPending':
        return { title: `Je hebt ${changesText(confirm.pending)} die nog niet verstuurd zijn.`, confirmLabel: 'Toch uitloggen' };
      case 'replaceCode':
        return { title: 'Code vervangen?', body: 'Links en codes die je al hebt gedeeld werken dan niet meer.', confirmLabel: 'Code vervangen' };
      case 'deleteAccount':
        return {
          title: 'Account verwijderen?',
          body: alone ? `${hh} en de lijst worden definitief verwijderd.` : `Je account wordt verwijderd. ${hh} blijft bestaan voor de andere leden.`,
          confirmLabel: 'Account verwijderen',
        };
    }
  })();

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]} edges={['top']}>
      <View style={styles.top}>
        <IconButton label="Terug" onPress={() => (router.canGoBack() ? router.back() : router.navigate('/'))} testID="back">
          <ChevronIcon direction="left" />
        </IconButton>
        <AppText variant="body" accessibilityRole="header" style={styles.strong}>
          Huishouden
        </AppText>
      </View>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.block}>
          <PrimaryButton label="Deel lijst" onPress={() => void share(false)} busy={sharing} />
          {code ? (
            <View style={styles.codeRow}>
              <AppText variant="footnote" color="textMuted" style={styles.flex} selectable testID="invite-code">
                {`Code: ${code}`}
              </AppText>
              {isOwner ? (
                <TextButton
                  label="Code vervangen"
                  tone="muted"
                  onPress={() => {
                    setConfirmError(null);
                    setConfirm({ kind: 'replaceCode' });
                  }}
                  disabled={sharing}
                />
              ) : null}
            </View>
          ) : null}
        </View>

        <View style={styles.block}>
          {isOwner ? (
            <TextField
              label="Naam"
              accessibilityLabel="Naam van het huishouden"
              value={name}
              onChangeText={(t) => {
                setNameDraft(t);
                if (nameError) setNameError(null);
              }}
              onBlur={() => void rename()}
              onSubmitEditing={() => void rename()}
              returnKeyType="done"
              maxLength={LIMITS.householdNameMaxLength}
              error={nameError}
              testID="household-name"
            />
          ) : (
            <AppText variant="body" testID="household-name-readonly">
              {household.name}
            </AppText>
          )}
        </View>

        <View style={styles.block}>
          <AppText variant="footnote" color="textMuted" accessibilityRole="header">
            Leden
          </AppText>
          {members.map((m) => (
            <MemberRow
              key={m.user_id}
              member={m}
              isMe={m.user_id === user.id}
              canRemove={isOwner && m.user_id !== user.id}
              onRemove={() => {
                setConfirmError(null);
                setConfirm({ kind: 'remove', member: m });
              }}
            />
          ))}
        </View>

        {prices.available ? (
          <View style={[styles.block, styles.toggleRow]}>
            <AppText variant="body" style={styles.flex}>
              Prijsvergelijking tonen
            </AppText>
            <Switch
              value={prices.optIn}
              onValueChange={(v) => void prices.setOptIn(v)}
              accessibilityLabel="Prijsvergelijking tonen"
              trackColor={{ true: c.accent, false: c.border }}
              thumbColor={c.surfaceRaised}
            />
          </View>
        ) : null}

        <View style={styles.block}>
          <AppText variant="footnote" color="textMuted" testID="signed-in-as">
            {`Ingelogd als ${user.email ?? user.displayName}`}
          </AppText>
          <TextButton label="Uitloggen" onPress={() => void signOut()} />
          <TextButton
            label="Huishouden verlaten"
            tone="danger"
            disabled={!online}
            onPress={() => {
              setConfirmError(null);
              setConfirm({ kind: 'leave' });
            }}
          />
          {!online ? (
            <AppText variant="footnote" color="textMuted">
              Verlaten kan alleen online
            </AppText>
          ) : null}
          <TextButton
            label="Account verwijderen"
            tone="muted"
            onPress={() => {
              setConfirmError(null);
              setConfirm({ kind: 'deleteAccount' });
            }}
          />
        </View>
      </ScrollView>
      <ConfirmSheet
        visible={!!confirmProps}
        title={confirmProps?.title ?? ''}
        body={confirmProps?.body}
        confirmLabel={confirmProps?.confirmLabel ?? ''}
        danger={confirm?.kind !== 'replaceCode'}
        busy={busy}
        error={confirmError}
        onConfirm={() => void runConfirm()}
        onCancel={() => {
          setConfirm(null);
          setConfirmError(null);
        }}
        testID="confirm-sheet"
      />
    </SafeAreaView>
  );
}

function MemberRow({ member, isMe, canRemove, onRemove }: { member: HouseholdMember; isMe: boolean; canRemove: boolean; onRemove(): void }) {
  const c = useColors();
  const name = member.display_name || 'Naamloos';
  const label = `${name}${isMe ? ' (jij)' : ''}${member.role === 'owner' ? ', eigenaar' : ''}`;
  return (
    <View style={[styles.member, { borderBottomColor: c.border }]}>
      <View style={styles.memberMain} accessible accessibilityLabel={label}>
        <View style={[styles.avatar, { backgroundColor: c.surface }]}>
          <AppText variant="footnote" style={styles.strong}>
            {initials(name)}
          </AppText>
        </View>
        <AppText variant="body" style={styles.flex}>
          {`${name}${isMe ? ' (jij)' : ''}`}
        </AppText>
        {member.role === 'owner' ? (
          <AppText variant="footnote" color="textMuted">
            Eigenaar
          </AppText>
        ) : null}
      </View>
      {canRemove ? <TextButton label="Verwijderen" accessibilityLabel={`${name} verwijderen`} tone="danger" onPress={onRemove} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, minHeight: sizes.minTouch + 4 },
  strong: { fontWeight: '600' },
  scroll: { paddingHorizontal: sizes.sideMargin, paddingBottom: spacing.xxl * 2, gap: spacing.xl, maxWidth: 640, width: '100%', alignSelf: 'center' },
  block: { gap: spacing.sm },
  codeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  flex: { flex: 1 },
  member: { flexDirection: 'row', alignItems: 'center', minHeight: sizes.rowMinHeight, borderBottomWidth: StyleSheet.hairlineWidth, gap: spacing.md },
  memberMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', minHeight: sizes.minTouch },
});
