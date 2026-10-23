import 'react-native-url-polyfill/auto';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import 'react-native-reanimated';

import { AppProviders } from '@/src/features/AppProviders';
import { useSession } from '@/src/features/session/SessionProvider';
import { getBackend } from '@/src/lib/backend';
import { palette } from '@/src/ui/tokens';
import { useScheme } from '@/src/ui/theme';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  anchor: '(tabs)',
};

function RootStack() {
  const { state } = useSession();
  const ready = state.kind === 'ready';
  const signedOut = state.kind === 'signedOut';
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={ready}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="household" />
      </Stack.Protected>
      <Stack.Protected guard={signedOut}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={!ready && !signedOut}>
        <Stack.Screen name="status" />
      </Stack.Protected>
      <Stack.Screen name="j/[code]" />
    </Stack>
  );
}

export default function RootLayout() {
  const scheme = useScheme();
  const c = palette[scheme];
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: { ...base.colors, primary: c.accent, background: c.bg, card: c.bg, text: c.text, border: c.border },
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider value={theme}>
          <AppProviders backend={getBackend()}>
            <RootStack />
          </AppProviders>
          <StatusBar style="auto" />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
