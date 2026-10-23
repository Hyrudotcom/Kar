/**
 * Line icons drawn with Views (no icon font or SVG dependency), so they look the same on iOS,
 * Android and web and inherit colour tokens. Decorative: callers set accessibility labels.
 */
import { Text, View, type ViewStyle } from 'react-native';

import { useColors } from './theme';
import type { ColorToken } from './tokens';

interface IconProps {
  size?: number;
  color?: ColorToken;
  style?: ViewStyle;
}

const STROKE = 1.75;

function Box({ size, children, style }: { size: number; children?: React.ReactNode; style?: ViewStyle }) {
  return (
    <View
      style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      aria-hidden>
      {children}
    </View>
  );
}

export function PlusIcon({ size = 24, color = 'text', style }: IconProps) {
  const c = useColors()[color];
  const len = size * 0.6;
  return (
    <Box size={size} style={style}>
      <View style={{ position: 'absolute', width: len, height: STROKE, backgroundColor: c, borderRadius: 1 }} />
      <View style={{ position: 'absolute', width: STROKE, height: len, backgroundColor: c, borderRadius: 1 }} />
    </Box>
  );
}

export function CloseIcon({ size = 24, color = 'text', style }: IconProps) {
  const c = useColors()[color];
  const len = size * 0.6;
  return (
    <Box size={size} style={style}>
      <View style={{ position: 'absolute', width: len, height: STROKE, backgroundColor: c, transform: [{ rotate: '45deg' }] }} />
      <View style={{ position: 'absolute', width: len, height: STROKE, backgroundColor: c, transform: [{ rotate: '-45deg' }] }} />
    </Box>
  );
}

export function CheckIcon({ size = 24, color = 'onAccent', style }: IconProps) {
  const c = useColors()[color];
  return (
    <Box size={size} style={style}>
      <View
        style={{
          width: size * 0.3,
          height: size * 0.55,
          borderRightWidth: 2,
          borderBottomWidth: 2,
          borderColor: c,
          transform: [{ translateY: -size * 0.06 }, { rotate: '45deg' }],
        }}
      />
    </Box>
  );
}

/** Chevron; direction: left (back), down (expanded), right (collapsed). */
export function ChevronIcon({ size = 24, color = 'text', direction = 'left', style }: IconProps & { direction?: 'left' | 'down' | 'right' | 'up' }) {
  const c = useColors()[color];
  const rot = { left: '45deg', down: '-45deg', right: '225deg', up: '135deg' }[direction];
  const shift = { left: size * 0.08, down: -size * 0.08, right: -size * 0.08, up: size * 0.08 }[direction];
  const horizontal = direction === 'left' || direction === 'right';
  return (
    <Box size={size} style={style}>
      <View
        style={{
          width: size * 0.38,
          height: size * 0.38,
          borderLeftWidth: 2,
          borderBottomWidth: 2,
          borderColor: c,
          transform: [horizontal ? { translateX: shift } : { translateY: shift }, { rotate: rot }],
        }}
      />
    </Box>
  );
}

/** "Huishouden": two people. */
export function PeopleIcon({ size = 24, color = 'text', style }: IconProps) {
  const c = useColors()[color];
  const head = size * 0.3;
  const body = size * 0.5;
  const person = (dx: number, scale: number, key: string) => (
    <View key={key} style={{ position: 'absolute', left: size / 2 - body / 2 + dx, top: size * 0.12, alignItems: 'center', transform: [{ scale }] }}>
      <View style={{ width: head, height: head, borderRadius: head, borderWidth: STROKE, borderColor: c }} />
      <View
        style={{
          marginTop: size * 0.06,
          width: body,
          height: body * 0.55,
          borderTopLeftRadius: body,
          borderTopRightRadius: body,
          borderWidth: STROKE,
          borderBottomWidth: 0,
          borderColor: c,
        }}
      />
    </View>
  );
  return <Box size={size} style={style}>{[person(size * 0.2, 0.85, 'b'), person(-size * 0.12, 1, 'a')]}</Box>;
}

/** Offline: cloud with a strike. */
export function CloudOffIcon({ size = 24, color = 'textMuted', style }: IconProps) {
  const c = useColors()[color];
  return (
    <Box size={size} style={style}>
      <View style={{ position: 'absolute', top: size * 0.36, width: size * 0.82, height: size * 0.38, borderRadius: size * 0.2, borderWidth: STROKE, borderColor: c }} />
      <View
        style={{
          position: 'absolute',
          top: size * 0.18,
          left: size * 0.3,
          width: size * 0.42,
          height: size * 0.42,
          borderRadius: size,
          borderWidth: STROKE,
          borderColor: c,
          borderBottomColor: 'transparent',
          transform: [{ rotate: '-20deg' }],
        }}
      />
      <View style={{ position: 'absolute', width: size * 1.0, height: STROKE + 0.5, backgroundColor: c, transform: [{ rotate: '-45deg' }] }} />
    </Box>
  );
}

/** Error: warning triangle with "!". Always paired with words in the sheet it opens. */
export function WarningIcon({ size = 24, color = 'danger', style }: IconProps) {
  const colors = useColors();
  const c = colors[color];
  const w = size * 0.9;
  const h = size * 0.8;
  return (
    <Box size={size} style={style}>
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: w / 2,
          borderRightWidth: w / 2,
          borderBottomWidth: h,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderBottomColor: c,
        }}
      />
      <Text
        allowFontScaling={false}
        style={{ position: 'absolute', top: size * 0.22, fontSize: size * 0.5, lineHeight: size * 0.6, fontWeight: '700', color: colors.bg }}>
        !
      </Text>
    </Box>
  );
}

function CircleGlyph({ size = 24, color = 'textMuted', glyph, style }: IconProps & { glyph: string }) {
  const c = useColors()[color];
  const d = size * 0.8;
  return (
    <Box size={size} style={style}>
      <View style={{ width: d, height: d, borderRadius: d, borderWidth: STROKE, borderColor: c, alignItems: 'center', justifyContent: 'center' }}>
        <Text allowFontScaling={false} style={{ color: c, fontSize: d * 0.62, lineHeight: d * 0.8, fontWeight: '600', textAlign: 'center' }}>
          {glyph}
        </Text>
      </View>
    </Box>
  );
}

export function InfoIcon(p: IconProps) {
  return <CircleGlyph {...p} glyph="i" />;
}

/** "Geen prijs" marker. */
export function QuestionIcon(p: IconProps) {
  return <CircleGlyph {...p} glyph="?" />;
}

/** "4 d oud" marker. */
export function ClockIcon({ size = 16, color = 'warning', style }: IconProps) {
  const c = useColors()[color];
  const d = size * 0.84;
  return (
    <Box size={size} style={style}>
      <View style={{ width: d, height: d, borderRadius: d, borderWidth: STROKE, borderColor: c }} />
      <View style={{ position: 'absolute', width: STROKE, height: d * 0.32, top: size / 2 - d * 0.3, backgroundColor: c }} />
      <View style={{ position: 'absolute', height: STROKE, width: d * 0.26, left: size / 2, top: size / 2 - STROKE / 2, backgroundColor: c }} />
    </Box>
  );
}

/** Tab "Mijn lijst" and the list empty state. */
export function ListIcon({ size = 24, color = 'text', style }: IconProps) {
  const c = useColors()[color];
  const row = (i: number) => (
    <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginVertical: size * 0.06 }}>
      <View style={{ width: size * 0.14, height: size * 0.14, borderRadius: size, borderWidth: STROKE * 0.9, borderColor: c }} />
      <View style={{ marginLeft: size * 0.1, width: size * 0.5, height: STROKE, backgroundColor: c, borderRadius: 1 }} />
    </View>
  );
  return <Box size={size} style={style}>{[0, 1, 2].map(row)}</Box>;
}

/** Tab "Goedkoopste route" and its empty states: a receipt. */
export function ReceiptIcon({ size = 24, color = 'text', style }: IconProps) {
  const c = useColors()[color];
  return (
    <Box size={size} style={style}>
      <View style={{ width: size * 0.62, height: size * 0.8, borderWidth: STROKE, borderColor: c, borderRadius: size * 0.08, alignItems: 'center', justifyContent: 'center' }}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={{ width: size * (i === 2 ? 0.2 : 0.34), alignSelf: 'center', height: STROKE * 0.9, backgroundColor: c, marginVertical: size * 0.05 }} />
        ))}
      </View>
    </Box>
  );
}

