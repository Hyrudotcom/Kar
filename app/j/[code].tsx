import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';

import { BootScreen } from '@/src/features/session/GateScreens';
import { normalizeInviteCode, useSession } from '@/src/features/session/SessionProvider';

/**
 * https://getkar.nl/j/<CODE> and kar://j/<CODE> (docs/architecture.md section 2).
 * Stores the code (SecureStore) and continues: signed in -> "Word je lid van …?" sheet over the list;
 * signed out -> sign-in, then straight to the confirmation.
 */
export default function JoinLinkScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const router = useRouter();
  const session = useSession();
  const handled = useRef(false);
  const kind = session.state.kind;

  useEffect(() => {
    if (kind === 'booting') return;
    if (!handled.current) {
      handled.current = true;
      const valid = normalizeInviteCode(String(code ?? ''));
      void session.setPendingInvite(valid ?? String(code ?? '').trim().toUpperCase().slice(0, 8));
    }
    router.replace(kind === 'ready' ? '/' : kind === 'signedOut' ? '/sign-in' : '/status');
  }, [kind, code, router, session]);

  return <BootScreen />;
}
