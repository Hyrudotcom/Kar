import { useColorScheme } from 'react-native';

import { palette, type Colors } from './tokens';

/** Returns the colour tokens for the current system scheme. Owner: mobile. */
export function useColors(): Colors {
  const scheme = useColorScheme();
  return scheme === 'dark' ? palette.dark : palette.light;
}
