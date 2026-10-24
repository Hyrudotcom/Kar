import { useColorScheme } from 'react-native';

import { palette, type ColorScheme, type Colors } from './tokens';

/** The current system scheme, 'light' unless the system says dark. */
export function useScheme(): ColorScheme {
  return useColorScheme() === 'dark' ? 'dark' : 'light';
}

/** Returns the colour tokens for the current system scheme. Owner: mobile. */
export function useColors(): Colors {
  return palette[useScheme()];
}
