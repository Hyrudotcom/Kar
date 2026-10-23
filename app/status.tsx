import { useSession } from '@/src/features/session/SessionProvider';
import { BootScreen, NoInternetScreen, RemovedScreen, SwitchAccountScreen } from '@/src/features/session/GateScreens';

/** Session states that are not "signed in with a list" and not "signed out". */
export default function StatusScreen() {
  const { state } = useSession();
  switch (state.kind) {
    case 'removed':
      return <RemovedScreen />;
    case 'noInternet':
      return <NoInternetScreen />;
    case 'switchAccount':
      return <SwitchAccountScreen />;
    default:
      return <BootScreen />;
  }
}
