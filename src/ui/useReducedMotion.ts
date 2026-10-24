import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** System "Reduce motion" (design-spec 2.3 / 7): animations become 0 ms. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((v) => alive && setReduced(!!v))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v: boolean) => setReduced(!!v));
    return () => {
      alive = false;
      sub?.remove?.();
    };
  }, []);
  return reduced;
}

/** Screen reader announcement; no-op where unsupported. */
export function announce(message: string): void {
  try {
    AccessibilityInfo.announceForAccessibility?.(message);
  } catch {
    /* web without support */
  }
}
