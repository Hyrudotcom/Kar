/** Connectivity port backed by @react-native-community/netinfo. */
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import type { Connectivity } from '@/src/contracts';

/** Online = connected and not known to be unreachable (isInternetReachable null = unknown = online). */
export function isOnlineState(s: Pick<NetInfoState, 'isConnected' | 'isInternetReachable'>): boolean {
  return s.isConnected !== false && s.isInternetReachable !== false;
}

export function createNetInfoConnectivity(): Connectivity & { dispose(): void } {
  // Optimistic until the first report, so the offline icon never flashes at startup.
  let online = true;
  const listeners = new Set<(online: boolean) => void>();
  const update = (s: NetInfoState) => {
    const next = isOnlineState(s);
    if (next === online) return;
    online = next;
    for (const l of [...listeners]) l(online);
  };
  const unsubscribe = NetInfo.addEventListener(update);
  NetInfo.fetch().then(update, () => undefined);
  return {
    isOnline: () => online,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: unsubscribe,
  };
}
