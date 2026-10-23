/**
 * Incoming URLs the router must not navigate to (app/+native-intent.ts). The Google sign-in redirect
 * (`<applicationId>:/oauthredirect`, expo-auth-session) also reaches expo-router on Android; it
 * belongs to the auth session, and as a route it would open "Deze pagina bestaat niet".
 */
export function isAuthRedirect(path: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(path);
  const scheme = m ? m[1]!.toLowerCase() : null;
  const rest = (m ? path.slice(m[0].length) : path).replace(/^\/\/[^/]*/, '');
  const pathname = rest.split(/[?#]/)[0]!.replace(/\/+$/, '');
  if (/^\/*oauthredirect$/i.test(pathname)) return true;
  // Our own links are goedboodschap:// and https (universal / app links); any other scheme is a
  // provider redirect (reverse client id, application id).
  return scheme !== null && scheme !== 'goedboodschap' && scheme !== 'https' && scheme !== 'http';
}

/** expo-router `redirectSystemPath`: no navigation for an auth redirect, the path otherwise. */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string {
  if (isAuthRedirect(path)) return initial ? '/' : '';
  return path;
}
