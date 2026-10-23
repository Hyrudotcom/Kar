import { googleClientIdFor, isGoogleConfigured } from '@/src/lib/auth/google';

/**
 * Regression: expo-auth-session's Google provider throws on a platform whose client id is missing
 * ("Client Id property `androidClientId` must be defined…"), which crashed the sign-in screen on
 * Android when only the web and iOS ids were configured.
 */
describe('Google sign-in availability is per platform', () => {
  const webAndIos = { googleIosClientId: 'ios-id', googleAndroidClientId: '', googleWebClientId: 'web-id' };

  it('is off on Android when only the web and iOS ids are set', () => {
    expect(isGoogleConfigured('android', webAndIos)).toBe(false);
    expect(isGoogleConfigured('ios', webAndIos)).toBe(true);
    expect(isGoogleConfigured('web', webAndIos)).toBe(true);
  });

  it('uses the id of the current platform only', () => {
    const ids = { googleIosClientId: 'i', googleAndroidClientId: 'a', googleWebClientId: 'w' };
    expect(['ios', 'android', 'web', 'windows'].map((os) => googleClientIdFor(os, ids))).toEqual(['i', 'a', 'w', 'w']);
    expect(isGoogleConfigured('ios', { ...ids, googleIosClientId: '' })).toBe(false);
  });
});
