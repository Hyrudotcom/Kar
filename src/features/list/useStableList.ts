import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LayoutAnimation, Platform } from 'react-native';

import type { ListSnapshot } from '@/src/contracts';
import { announce } from '@/src/ui';
import { motion } from '@/src/ui/tokens';

import { StableOrder, type StableView } from './stableOrder';

export interface StableList extends StableView {
  /** Finger down on the list or scroll started: nothing may move. */
  onInteractionStart(): void;
  /** Finger up / scroll ended: settle again after the rest period. */
  onInteractionEnd(): void;
  /** A checkbox was tapped: restart the 1.5 s rest period. */
  onCheckTap(): void;
}

/** Applies the "nothing moves under your finger" layer to the engine snapshot (design-spec 4.3). */
export function useStableList(snapshot: ListSnapshot, reducedMotion: boolean): StableList {
  const [order] = useState(() => new StableOrder());
  const [tick, setTick] = useState(0);
  const interacting = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const view = useMemo(() => order.compute(snapshot.open, snapshot.checked), [snapshot, tick, order]);
  const lingeringKey = view.lingering.join(',');
  const hasLingering = view.lingering.length > 0;
  const reducedRef = useRef(reducedMotion);
  useLayoutEffect(() => {
    reducedRef.current = reducedMotion;
  });

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const schedule = useCallback(() => {
    clear();
    if (interacting.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (interacting.current) return;
      if (!order.settle()) return;
      if (reducedRef.current) announce('Afgevinkte items verplaatst');
      else if (Platform.OS !== 'web') {
        LayoutAnimation.configureNext(LayoutAnimation.create(motion.durationMs, LayoutAnimation.Types.easeOut, LayoutAnimation.Properties.opacity));
      }
      setTick((t) => t + 1);
    }, motion.settleBeforeMoveMs);
  }, [clear, order]);

  // A new row started lingering (own tap or another member's check): restart the rest period.
  useEffect(() => {
    if (hasLingering) schedule();
    else clear();
  }, [lingeringKey, hasLingering, schedule, clear]);

  useEffect(() => clear, [clear]);

  const onInteractionStart = useCallback(() => {
    interacting.current = true;
    clear();
  }, [clear]);

  const onInteractionEnd = useCallback(() => {
    interacting.current = false;
    if (order.view().lingering.length > 0) schedule();
  }, [order, schedule]);

  return { ...view, onInteractionStart, onInteractionEnd, onCheckTap: schedule };
}
