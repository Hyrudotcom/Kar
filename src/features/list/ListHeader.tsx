import type { ReactNode } from 'react';
import { View } from 'react-native';

import { IconButton, PeopleIcon, ScreenHeader } from '@/src/ui';

/** Compact one-line header: household name, sync icon (only when needed), "Huishouden" (design-spec 3). */
export function ListHeader({ name, sync, onHousehold }: { name: string; sync: ReactNode; onHousehold(): void }) {
  return (
    <ScreenHeader
      title={name}
      right={
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {sync}
          <IconButton label="Huishouden" onPress={onHousehold} testID="household-button">
            <PeopleIcon size={24} />
          </IconButton>
        </View>
      }
    />
  );
}
