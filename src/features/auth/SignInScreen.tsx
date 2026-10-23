/**
 * Inloggen (design-spec 4.1): Apple (iOS first) / Google (Android first) / e-mail with a 6-digit
 * code only. No carousel. "Ik heb een uitnodigingscode" stores a code for after sign-in.
 */
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { appleIdToken } from '@/src/lib/auth/apple';
import { useGoogleIdToken } from '@/src/lib/auth/google';
import type { AuthResult } from '@/src/lib/backend/types';
import { AppText, Divider, OutlineButton, PrimaryButton, TextButton, TextField, useColors } from '@/src/ui';
import { MAX_FONT_SCALE, radius, sizes, spacing } from '@/src/ui/tokens';

import { useBackend } from '../session/BackendContext';
import { authErrorText } from '../session/copy';
import { useSession } from '../session/SessionProvider';
import { InviteCodeSheet } from './InviteCodeSheet';

const RESEND_AFTER_S = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function SignInScreen() {
  const c = useColors();
  const backend = useBackend();
  const session = useSession();
  const [step, setStep] = useState<'start' | 'code'>('start');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'email' | 'apple' | 'google' | 'code'>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const run = async (which: NonNullable<typeof busy>, fn: () => Promise<AuthResult>): Promise<boolean> => {
    setBusy(which);
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) setError(authErrorText(r.error));
      return r.ok;
    } finally {
      setBusy(null);
    }
  };

  const sendCode = async () => {
    const e = email.trim();
    if (!EMAIL_RE.test(e)) {
      setError(authErrorText('invalid_email'));
      return;
    }
    if (await run('email', () => backend.auth.sendEmailCode(e))) setStep('code');
  };

  const apple = () =>
    run('apple', async () => {
      if (backend.mode === 'demo') return backend.auth.signInWithIdToken('apple', 'demo');
      const t = await appleIdToken();
      if (!t.ok) return { ok: false, error: t.error };
      return backend.auth.signInWithIdToken('apple', t.idToken, t.nonce, t.fullName);
    });

  if (step === 'code') {
    return (
      <CodeStep
        email={email.trim()}
        demo={backend.mode === 'demo'}
        onBack={() => {
          setStep('start');
          setError(null);
        }}
        onResend={() => backend.auth.sendEmailCode(email.trim())}
        onVerify={(code) => backend.auth.verifyEmailCode(email.trim(), code)}
      />
    );
  }

  const showApple = backend.providers.apple && (backend.mode === 'demo' || Platform.OS === 'ios');
  const showGoogle = backend.providers.google;
  const appleButton = showApple ? <OutlineButton key="apple" label="Doorgaan met Apple" onPress={() => void apple()} busy={busy === 'apple'} disabled={!!busy} /> : null;
  const googleButton = showGoogle ? (
    backend.mode === 'supabase' ? (
      <GoogleButton key="google" disabled={!!busy} busy={busy === 'google'} run={(fn) => run('google', fn)} />
    ) : (
      <OutlineButton key="google" label="Doorgaan met Google" onPress={() => void run('google', () => backend.auth.signInWithIdToken('google', 'demo'))} busy={busy === 'google'} disabled={!!busy} />
    )
  ) : null;
  // iOS shows Apple first, Android shows Google first.
  const social = Platform.OS === 'android' ? [googleButton, appleButton] : [appleButton, googleButton];

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]}>
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.head}>
            <AppText variant="title" align="center" accessibilityRole="header">
              Goedboodschap
            </AppText>
            <AppText variant="callout" color="textMuted" align="center">
              Samen één boodschappenlijst
            </AppText>
          </View>
          {showApple || showGoogle ? (
            <>
              <View style={styles.stack}>{social}</View>
              <View style={styles.or} accessible={false} importantForAccessibility="no-hide-descendants">
                <Divider style={styles.orLine} />
                <AppText variant="footnote" color="textMuted">
                  of
                </AppText>
                <Divider style={styles.orLine} />
              </View>
            </>
          ) : null}
          <View style={styles.stack}>
            <TextField
              label="E-mailadres"
              value={email}
              onChangeText={(t) => {
                setEmail(t);
                if (error) setError(null);
              }}
              onSubmitEditing={() => void sendCode()}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              inputMode="email"
              returnKeyType="send"
              placeholder="naam@voorbeeld.nl"
              testID="email"
            />
            {error ? (
              <AppText variant="callout" color="danger" accessibilityLiveRegion="polite" testID="signin-error">
                {error}
              </AppText>
            ) : null}
            <PrimaryButton label="Stuur code" onPress={() => void sendCode()} busy={busy === 'email'} disabled={!!busy && busy !== 'email'} />
          </View>
          <View style={styles.foot}>
            <AppText variant="footnote" color="textMuted">
              Door verder te gaan ga je akkoord met de voorwaarden.
            </AppText>
            {session.pendingInvite ? (
              <AppText variant="footnote" color="textMuted" testID="pending-invite">
                {`Code ${session.pendingInvite} bewaard. Log in om lid te worden.`}
              </AppText>
            ) : null}
            <TextButton label="Ik heb een uitnodigingscode" onPress={() => setInviteOpen(true)} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      {inviteOpen ? (
      <InviteCodeSheet
        visible
        onClose={() => setInviteOpen(false)}
        onCode={async (code) => {
          await session.setPendingInvite(code);
          setInviteOpen(false);
        }}
      />
      ) : null}
    </SafeAreaView>
  );
}

function GoogleButton({ disabled, busy, run }: { disabled: boolean; busy: boolean; run(fn: () => Promise<AuthResult>): Promise<boolean> }) {
  const backend = useBackend();
  const google = useGoogleIdToken();
  return (
    <OutlineButton
      label="Doorgaan met Google"
      busy={busy}
      disabled={disabled || !google.ready}
      onPress={() =>
        void run(async () => {
          const t = await google.start();
          if (!t.ok) return { ok: false, error: t.error };
          return backend.auth.signInWithIdToken('google', t.idToken, t.nonce);
        })
      }
    />
  );
}

/** "Typ de code uit je mail": 6 digits, OS autofill, continues by itself at 6 (design-spec 4.1). */
export function CodeStep({
  email,
  demo,
  onBack,
  onResend,
  onVerify,
}: {
  email: string;
  demo?: boolean;
  onBack(): void;
  onResend(): Promise<AuthResult>;
  onVerify(code: string): Promise<AuthResult>;
}) {
  const c = useColors();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [networkError, setNetworkError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(RESEND_AFTER_S);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const verify = async (value: string) => {
    setBusy(true);
    setError(null);
    setNetworkError(false);
    const r = await onVerify(value);
    setBusy(false);
    if (!r.ok) {
      setError(authErrorText(r.error));
      setNetworkError(r.error === 'network');
      if (r.error !== 'network') setCode('');
      inputRef.current?.focus();
    }
  };

  const onChange = (t: string) => {
    const digits = t.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    if (error) setError(null);
    if (digits.length === 6 && !busy) void verify(digits);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.stack}>
          <AppText variant="title" accessibilityRole="header">
            Typ de code uit je mail
          </AppText>
          <AppText variant="callout" color="textMuted">{`Gestuurd naar ${email}`}</AppText>
          <Pressable onPress={() => inputRef.current?.focus()} accessible={false} style={styles.cells}>
            {Array.from({ length: 6 }, (_, i) => (
              <View
                key={i}
                style={[
                  styles.cell,
                  { backgroundColor: c.surface, borderColor: i === code.length && !busy ? c.accent : error ? c.danger : 'transparent' },
                ]}>
                <AppText variant="title" tabular>
                  {code[i] ?? ''}
                </AppText>
              </View>
            ))}
            <TextInput
              ref={inputRef}
              value={code}
              onChangeText={onChange}
              autoFocus
              keyboardType="number-pad"
              inputMode="numeric"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              maxLength={6}
              editable={!busy}
              caretHidden
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              accessibilityLabel="Code van 6 cijfers"
              accessibilityValue={{ text: code.split('').join(' ') }}
              testID="otp"
              style={styles.hiddenInput}
            />
          </Pressable>
          {error ? (
            <AppText variant="callout" color="danger" accessibilityLiveRegion="polite" testID="code-error">
              {error}
            </AppText>
          ) : null}
          {networkError ? <TextButton label="Opnieuw proberen" onPress={() => void verify(code)} /> : null}
          {demo ? (
            <AppText variant="footnote" color="textMuted">
              Demomodus: elke code van 6 cijfers werkt, behalve 000000.
            </AppText>
          ) : null}
          <TextButton
            label={wait > 0 ? `Opnieuw sturen (${wait} s)` : 'Opnieuw sturen'}
            accessibilityLabel={wait > 0 ? `Opnieuw sturen, kan over ${wait} seconden` : 'Opnieuw sturen'}
            disabled={wait > 0}
            onPress={async () => {
              const r = await onResend();
              if (r.ok) {
                setWait(RESEND_AFTER_S);
                setError(null);
              } else setError(authErrorText(r.error));
            }}
          />
          <TextButton label="Ander e-mailadres" tone="muted" onPress={onBack} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: sizes.sideMargin + spacing.sm, paddingVertical: spacing.xxl, gap: spacing.xl, maxWidth: 480, width: '100%', alignSelf: 'center' },
  head: { gap: spacing.xs, marginBottom: spacing.sm },
  stack: { gap: spacing.md },
  or: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  orLine: { flex: 1 },
  foot: { gap: spacing.xs },
  cells: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.sm },
  cell: { flex: 1, minHeight: 56, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, maxWidth: 56 },
  hiddenInput: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.011, color: 'transparent' },
});
