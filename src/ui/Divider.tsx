import { StyleSheet, View, type ViewStyle } from 'react-native';

import { useColors } from './theme';

/** Hairline in `border`. */
export function Divider({ inset = 0, style }: { inset?: number; style?: ViewStyle }) {
  const c = useColors();
  return <View style={[{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginLeft: inset }, style]} />;
}
