import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, IconButton, PeopleIcon } from '@/src/ui';
import { sizes } from '@/src/ui/tokens';

/** Compact one-line header: household name, sync icon (only when needed), "Huishouden" (design-spec 3). */
export function ListHeader({ name, sync, onHousehold }: { name: string; sync: ReactNode; onHousehold(): void }) {
  return (
    <View style={styles.row}>
      <AppText variant="body" accessibilityRole="header" numberOfLines={1} style={styles.name}>
        {name}
      </AppText>
      {sync}
      <IconButton label="Huishouden" onPress={onHousehold} testID="household-button">
        <PeopleIcon size={24} />
      </IconButton>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: sizes.minTouch + 4, paddingLeft: sizes.sideMargin, paddingRight: sizes.sideMargin - 12 },
  name: { flex: 1 },
});
