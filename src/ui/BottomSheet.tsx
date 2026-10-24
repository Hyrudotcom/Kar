import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from './Text';
import { useColors, useScheme } from './theme';
import { motion, radius, sizes, spacing } from './tokens';
import { useReducedMotion } from './useReducedMotion';

export interface BottomSheetProps {
  visible: boolean;
  /** Swipe down, tap outside, Android back or screen-reader escape. There is no "Klaar" button. */
  onClose: () => void;
  /** Optional sheet title (title typography). */
  title?: string;
  /** Pinned under the title (does not scroll), with a hairline below it (D3-15). */
  header?: ReactNode;
  children?: ReactNode;
  testID?: string;
  /** Screen-reader name of the sheet when there is no title. */
  accessibilityLabel?: string;
}

const CLOSE_DISTANCE = 80;

/** Bottom sheet on `surfaceRaised` with a top radius of 20 (design-spec 3). */
export function BottomSheet({ visible, onClose, title, header, children, testID, accessibilityLabel }: BottomSheetProps) {
  const c = useColors();
  const scheme = useScheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [translate] = useState(() => new Animated.Value(0));
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!visible) return;
    translate.setValue(reduced ? 0 : 400);
    Animated.timing(translate, { toValue: 0, duration: reduced ? 0 : motion.durationMs, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [visible, reduced, translate]);

  // The ref is only read inside gesture callbacks, never during render.
  // eslint-disable-next-line react-hooks/refs
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => translate.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_, g) => {
        if (g.dy > CLOSE_DISTANCE || g.vy > 1.2) onCloseRef.current();
        else Animated.spring(translate, { toValue: 0, useNativeDriver: Platform.OS !== 'web', bounciness: 0 }).start();
      },
      onPanResponderTerminate: () => Animated.spring(translate, { toValue: 0, useNativeDriver: Platform.OS !== 'web', bounciness: 0 }).start(),
    }),
  );

  if (!visible) return null;
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable
          style={[StyleSheet.absoluteFill, scheme === 'dark' ? styles.backdropDark : styles.backdrop]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Sluiten"
          testID={testID ? `${testID}-backdrop` : 'sheet-backdrop'}
        />
        <Animated.View
          testID={testID}
          accessibilityViewIsModal
          aria-modal
          accessibilityLabel={accessibilityLabel ?? title}
          onAccessibilityEscape={onClose}
          style={[
            styles.sheet,
            { backgroundColor: c.surfaceRaised, paddingBottom: Math.max(insets.bottom, spacing.lg), transform: [{ translateY: translate }] },
          ]}>
          <View {...pan.panHandlers} style={styles.grabZone}>
            <View style={[styles.grabber, { backgroundColor: c.border }]} />
            {title ? (
              <AppText variant="title" accessibilityRole="header" style={styles.title}>
                {title}
              </AppText>
            ) : null}
            {header}
          </View>
          {header ? <View style={[styles.headerLine, { backgroundColor: c.border }]} /> : null}
          <ScrollView keyboardShouldPersistTaps="handled" bounces={false} contentContainerStyle={styles.content}>
            {children}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.32)' },
  /** Dark mode: a 32% scrim barely dims a near-black list, so sheets blended in (D2-14). */
  backdropDark: { backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '90%',
    width: '100%',
    maxWidth: 640,
    alignSelf: 'center',
  },
  grabZone: { paddingTop: spacing.sm, paddingHorizontal: sizes.sideMargin, minHeight: 28 },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, marginBottom: spacing.md },
  title: { marginBottom: spacing.sm },
  headerLine: { height: StyleSheet.hairlineWidth, marginTop: spacing.sm },
  content: { paddingHorizontal: sizes.sideMargin, paddingBottom: spacing.sm, gap: spacing.md },
});
