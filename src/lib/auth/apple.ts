/** Sign in with Apple (iOS only): nonce via expo-crypto SHA-256 (docs/architecture.md section 2). */
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';

export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

export type IdTokenOutcome =
  | { ok: true; idToken: string; nonce: string; fullName: string | null }
  | { ok: false; error: 'cancelled' | 'unavailable' | 'unknown' };

export async function appleIdToken(): Promise<IdTokenOutcome> {
  try {
    const rawNonce = Crypto.randomUUID();
    const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
    const cred = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: hashed,
    });
    if (!cred.identityToken) return { ok: false, error: 'unknown' };
    const fullName = [cred.fullName?.givenName, cred.fullName?.familyName].filter(Boolean).join(' ') || null;
    return { ok: true, idToken: cred.identityToken, nonce: rawNonce, fullName };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === 'ERR_REQUEST_CANCELED' || code === 'ERR_CANCELED') return { ok: false, error: 'cancelled' };
    return { ok: false, error: 'unknown' };
  }
}
