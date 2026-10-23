import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { useColors } from '@/src/ui/theme';
import { typography } from '@/src/ui/tokens';

export default function NotFoundScreen() {
  const c = useColors();
  return (
    <>
      <Stack.Screen options={{ title: 'Niet gevonden' }} />
      <View style={[styles.container, { backgroundColor: c.bg }]}>
        <Text style={[typography.title, { color: c.text }]}>Deze pagina bestaat niet.</Text>
        <Link href="/" style={[typography.body, styles.link, { color: c.accent }]}>
          Naar Mijn lijst
        </Link>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  link: { marginTop: 16, paddingVertical: 12 },
});
