import { Text, type TextProps, type TextStyle } from 'react-native';

import { useColors } from './theme';
import { MAX_FONT_SCALE, typography, type ColorToken, type TypographyToken } from './tokens';

export interface AppTextProps extends TextProps {
  variant?: TypographyToken;
  color?: ColorToken;
  /** Amounts: tabular figures, never truncated. */
  tabular?: boolean;
  strike?: boolean;
  align?: TextStyle['textAlign'];
}

/** Text with design-spec typography and colour tokens; scales with system text size up to 200 %. */
export function AppText({ variant = 'body', color = 'text', tabular, strike, align, style, ...rest }: AppTextProps) {
  const c = useColors();
  return (
    <Text
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      {...rest}
      style={[
        typography[variant],
        { color: c[color] },
        tabular ? { fontVariant: ['tabular-nums'] } : null,
        strike ? { textDecorationLine: 'line-through' } : null,
        align ? { textAlign: align } : null,
        style,
      ]}
    />
  );
}
