import { useSession } from '@/src/features/session/SessionProvider';
import { BootScreen, RemovedScreen, SwitchAccountScreen, UnavailableScreen } from '@/src/features/session/GateScreens';

/** Session states that are not "signed in with a list" and not "signed out". */
export default function StatusScreen() {
  const { state } = useSession();
  switch (state.kind) {
    case 'removed':
      return <RemovedScreen />;
    case 'unavailable':
      return <UnavailableScreen />;
    case 'switchAccount':
      return <SwitchAccountScreen />;
    default:
      return <BootScreen />;
  }
}
