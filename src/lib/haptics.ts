/** Haptics (design-spec 2.3): light on check, medium on delete. No-op on web and in tests. */
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

export function hapticLight(): void {
  if (Platform.OS === 'web') return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

export function hapticMedium(): void {
  if (Platform.OS === 'web') return;
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
}
