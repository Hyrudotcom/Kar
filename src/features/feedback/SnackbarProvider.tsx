/**
 * UndoSnackbar host (design-spec 3): bottom, 5 s, one action "Ongedaan maken". Several actions of
 * the same group in quick succession add up in one snackbar ("3 items verwijderd · Ongedaan maken"
 * restores all three). Every snackbar is announced to screen readers.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Keyboard, StyleSheet, View, type KeyboardEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { announce, Snackbar } from '@/src/ui';
import { motion, sizes, spacing } from '@/src/ui/tokens';

export const UNDO_LABEL = 'Ongedaan maken';

export interface SnackInput {
  message: string;
  /** Called when the action is tapped. Omit for an informational toast ("Je hebt Thuis verlaten"). */
  onAction?: () => void | Promise<void>;
  actionLabel?: string;
  /** Snackbars with the same group merge while visible; `groupMessage(count)` renders the sum. */
  group?: string;
  groupMessage?: (count: number) => string;
  /** How many things this snackbar stands for (default 1). */
  count?: number;
}

interface Current {
  key: number;
  message: string;
  actionLabel?: string;
  actions: (() => void | Promise<void>)[];
  group?: string;
  groupMessage?: (count: number) => string;
  count: number;
}

interface SnackbarApi {
  show(input: SnackInput): void;
  hide(): void;
}

const Ctx = createContext<SnackbarApi | null>(null);

/** Keyboard height (0 when hidden): the snackbar must stay visible while the user keeps adding items. */
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const onShow = (e: KeyboardEvent) => setHeight(e?.endCoordinates?.height ?? 0);
    const onHide = () => setHeight(0);
    // iOS sends Will* (in time for the animation), Android only Did*.
    const subs = [
      Keyboard.addListener('keyboardWillShow', onShow),
      Keyboard.addListener('keyboardDidShow', onShow),
      Keyboard.addListener('keyboardWillHide', onHide),
      Keyboard.addListener('keyboardDidHide', onHide),
    ];
    return () => subs.forEach((x) => x.remove());
  }, []);
  return height;
}

export function SnackbarProvider({
  children,
  bottomOffset = 64,
  resetKey,
}: {
  children: ReactNode;
  bottomOffset?: number;
  /** When this changes (other account, household or engine), a visible snackbar and its undo go away. */
  resetKey?: unknown;
}) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const [current, setCurrent] = useState<Current | null>(null);
  const currentRef = useRef<Current | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyRef = useRef(0);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    currentRef.current = null;
    setCurrent(null);
  }, []);

  const show = useCallback(
    (input: SnackInput) => {
      const prev = currentRef.current;
      let next: Current;
      if (prev && input.group && prev.group === input.group) {
        const count = prev.count + (input.count ?? 1);
        next = {
          ...prev,
          key: ++keyRef.current,
          count,
          message: input.groupMessage ? input.groupMessage(count) : input.message,
          actions: input.onAction ? [...prev.actions, input.onAction] : prev.actions,
        };
      } else {
        next = {
          key: ++keyRef.current,
          message: input.message,
          actionLabel: input.onAction ? (input.actionLabel ?? UNDO_LABEL) : undefined,
          actions: input.onAction ? [input.onAction] : [],
          group: input.group,
          groupMessage: input.groupMessage,
          count: input.count ?? 1,
        };
      }
      currentRef.current = next;
      setCurrent(next);
      announce(next.actionLabel ? `${next.message}. ${next.actionLabel}` : next.message);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(hide, motion.undoMs);
    },
    [hide],
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // An undo of the previous account or household must never be offered (it would act on a disposed engine).
  // Informational toasts ("Je hebt Thuis verlaten") may stay.
  useEffect(() => {
    if (currentRef.current?.actions.length) hide();
  }, [resetKey, hide]);

  const onAction = useCallback(() => {
    const c = currentRef.current;
    hide();
    if (!c) return;
    // Undo in reverse order: the last action is undone first.
    void (async () => {
      for (const a of [...c.actions].reverse()) {
        try {
          await a();
        } catch {
          /* the engine reports failures through the sync icon */
        }
      }
    })();
  }, [hide]);

  const api = useMemo(() => ({ show, hide }), [show, hide]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {current ? (
        <View pointerEvents="box-none" style={[styles.host, { bottom: Math.max(insets.bottom + bottomOffset, keyboard + spacing.sm) }]} testID="snackbar-host">
          <Snackbar key={current.key} message={current.message} actionLabel={current.actionLabel} onAction={current.actionLabel ? onAction : undefined} />
        </View>
      ) : null}
    </Ctx.Provider>
  );
}

export function useSnackbar(): SnackbarApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSnackbar outside SnackbarProvider');
  return c;
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: sizes.sideMargin, right: sizes.sideMargin, maxWidth: 608, alignSelf: 'center' },
});
