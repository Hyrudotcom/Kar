/**
 * Design tokens from design-spec.md section 2. Owner: mobile.
 * Do not add colours: one accent, greys, status colours only with an icon or word.
 */
export const palette = {
  light: {
    bg: '#FFFFFF',
    surface: '#F6F7F6',
    surfaceRaised: '#FFFFFF',
    border: '#E4E7E5',
    text: '#111413',
    textMuted: '#5E6662',
    textDisabled: '#8E9692',
    accent: '#1E7A4C',
    accentSoft: '#E6F3EC',
    onAccent: '#FFFFFF',
    warning: '#8A5A00',
    danger: '#B3261E',
    dangerSoft: '#FDECEA',
  },
  dark: {
    bg: '#0F1110',
    surface: '#181B19',
    surfaceRaised: '#1F2321',
    border: '#2A2F2C',
    text: '#ECEFED',
    textMuted: '#9BA39F',
    textDisabled: '#6B736F',
    accent: '#4CC38A',
    accentSoft: '#173226',
    onAccent: '#0F1110',
    warning: '#F2B84B',
    danger: '#FF8A80',
    dangerSoft: '#3A1714',
  },
} as const;

export type ColorScheme = keyof typeof palette;
export type ColorToken = keyof (typeof palette)['light'];
export type Colors = Record<ColorToken, string>;

export const typography = {
  title: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  body: { fontSize: 17, lineHeight: 22, fontWeight: '400' },
  bodyStrong: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  callout: { fontSize: 15, lineHeight: 20, fontWeight: '400' },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 20 } as const;
export const sizes = {
  sideMargin: 16,
  minTouch: 48,
  checkboxVisual: 24,
  rowMinHeight: 56,
  inputHeight: 48,
  buttonHeight: 48,
} as const;
export const motion = { durationMs: 180, reducedDurationMs: 0, settleBeforeMoveMs: 1500, undoMs: 5000 } as const;
