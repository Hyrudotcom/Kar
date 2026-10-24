/** Shared jest.mock factories (jest.mock itself must be called from each test file). */
export function safeAreaMock() {
  const { View } = jest.requireActual('react-native');
  return {
    SafeAreaView: View,
    SafeAreaProvider: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
}

export const clipboard: { text: string | null } = { text: null };
export function clipboardMock() {
  return {
    setStringAsync: async (t: string) => {
      clipboard.text = t;
      return true;
    },
  };
}
