/**
 * Google sign-in via expo-auth-session: obtains an ID token, then the session layer exchanges it with
 * supabase.auth.signInWithIdToken({ provider: 'google', token, nonce }).
 * We pass our own SHA-256-hashed nonce to Google and the raw nonce to Supabase.
 */
import * as Google from 'expo-auth-session/providers/google';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { env } from '../env';
import type { IdTokenOutcome } from './apple';

WebBrowser.maybeCompleteAuthSession();

type GoogleIds = Pick<typeof env, 'googleIosClientId' | 'googleAndroidClientId' | 'googleWebClientId'>;

/**
 * The client id expo-auth-session uses on this platform (iOS id on iOS, Android id on Android, web id
 * elsewhere). Its Google provider throws when that one is missing, so the button is only offered
 * when the CURRENT platform's id is set; ids of other platforms do not count.
 */
export function googleClientIdFor(os: string, ids: GoogleIds = env): string {
  if (os === 'ios') return ids.googleIosClientId;
  if (os === 'android') return ids.googleAndroidClientId;
  return ids.googleWebClientId;
}

export const isGoogleConfigured = (os: string = Platform.OS, ids: GoogleIds = env): boolean => googleClientIdFor(os, ids).length > 0;

function useNonce(): { raw: string; hashed: string } | null {
  const [nonce, setNonce] = useState<{ raw: string; hashed: string } | null>(null);
  useEffect(() => {
    let alive = true;
    const raw = Crypto.randomUUID();
    Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, raw).then(
      (hashed) => alive && setNonce({ raw, hashed }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);
  return nonce;
}

/** Returns `start()`; resolves with the ID token or a cancellation. `ready` is false until the request is prepared. */
export function useGoogleIdToken(): { ready: boolean; start: () => Promise<IdTokenOutcome> } {
  const nonce = useNonce();
  const [request, , promptAsync] = Google.useIdTokenAuthRequest({
    iosClientId: env.googleIosClientId || undefined,
    androidClientId: env.googleAndroidClientId || undefined,
    webClientId: env.googleWebClientId || undefined,
    extraParams: nonce ? { nonce: nonce.hashed } : undefined,
  });
  const start = useCallback(async (): Promise<IdTokenOutcome> => {
    if (!request || !nonce) return { ok: false, error: 'unavailable' };
    try {
      const res = await promptAsync();
      if (res.type === 'success') {
        const idToken = res.params.id_token ?? res.authentication?.idToken;
        return idToken ? { ok: true, idToken, nonce: nonce.raw, fullName: null } : { ok: false, error: 'unknown' };
      }
      if (res.type === 'cancel' || res.type === 'dismiss') return { ok: false, error: 'cancelled' };
      return { ok: false, error: 'unknown' };
    } catch {
      return { ok: false, error: 'unknown' };
    }
  }, [request, nonce, promptAsync]);
  return { ready: !!request && !!nonce, start };
}
