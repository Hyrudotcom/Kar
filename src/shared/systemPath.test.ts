import { isAuthRedirect, redirectSystemPath } from './systemPath';

describe('incoming system paths (round 4: Google sign-in on Android)', () => {
  it('ignores the OAuth redirect instead of routing to "Deze pagina bestaat niet"', () => {
    expect(isAuthRedirect('nl.goedboodschap.app:/oauthredirect?code=abc&state=x')).toBe(true);
    expect(isAuthRedirect('com.googleusercontent.apps.123:/oauthredirect')).toBe(true);
    expect(isAuthRedirect('/oauthredirect?code=1')).toBe(true);
    expect(redirectSystemPath({ path: 'nl.goedboodschap.app:/oauthredirect?code=abc', initial: false })).toBe('');
    expect(redirectSystemPath({ path: 'nl.goedboodschap.app:/oauthredirect?code=abc', initial: true })).toBe('/');
  });

  it('keeps invite links and other own paths', () => {
    for (const p of ['goedboodschap://j/ABC234', 'https://goedboodschap.nl/j/ABC234', '/j/ABC234', '/household', '/']) {
      expect(isAuthRedirect(p)).toBe(false);
      expect(redirectSystemPath({ path: p, initial: false })).toBe(p);
    }
  });
});
