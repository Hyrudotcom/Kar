/**
 * Item detail bottom sheet (design-spec 4.4): name, "Hoeveelheid" (same parser), "Notitie"
 * (max 140), "Toegevoegd door Sanne · 10:42", text button "Verwijderen". Saves after 1 s pause or
 * when leaving a field; closing (swipe down / tap outside) saves too. No "Klaar" button.
 * Render with `key={itemId}` so every item starts with fresh field state.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { LIMITS, type HouseholdMember, type Unit, type Uuid, type VisibleItem } from '@/src/contracts';
import { cleanItemName, formatQuantityField, parseQuantityField } from '@/src/shared/quantity';
import { useItem, useSyncEngine } from '@/src/sync/hooks';
import { AppText, BottomSheet, TextButton, TextField } from '@/src/ui';
import { spacing } from '@/src/ui/tokens';

import { formatWhen } from './time';

const SAVE_DELAY_MS = 1000;
export const QUANTITY_HINT = 'Bijvoorbeeld 2, 500 g of 1,5 l';

export function addedByText(item: Pick<VisibleItem, 'created_by' | 'created_at'>, members: readonly HouseholdMember[], me: Uuid): string {
  const who = item.created_by === me ? 'jou' : (members.find((m) => m.user_id === item.created_by)?.display_name || 'een huisgenoot');
  const when = formatWhen(item.created_at);
  return `Toegevoegd door ${who}${when ? ` · ${when}` : ''}`;
}

interface Fields {
  name: string;
  quantity: string;
  note: string;
}

const fieldsOf = (i: VisibleItem): Fields => ({ name: i.name, quantity: formatQuantityField(i.quantity, i.unit), note: i.note });

export function ItemDetailSheet({
  itemId,
  members,
  me,
  onClose,
  onDeleted,
  onGone,
}: {
  itemId: Uuid | null;
  members: readonly HouseholdMember[];
  me: Uuid;
  onClose(): void;
  /** The user tapped "Verwijderen" here. */
  onDeleted(item: VisibleItem): void;
  /** Someone else deleted the item while the sheet was open (F12). */
  onGone(item: VisibleItem): void;
}) {
  const engine = useSyncEngine();
  const item = useItem(itemId);
  const last = useRef<VisibleItem | null>(null);
  const [fields, setFields] = useState<Fields | null>(null);
  const [qtyError, setQtyError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const dirty = useRef<Set<keyof Fields>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deletingRef = useRef(false);
  const fieldsRef = useRef<Fields | null>(null);
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  useLayoutEffect(() => {
    fieldsRef.current = fields;
  });

  // Keep untouched fields in sync with changes from others (edits update in place, 4.3 rule 4).
  useEffect(() => {
    if (!item) return;
    last.current = item;
    setFields((f) => {
      const fresh = fieldsOf(item);
      if (!f) return fresh;
      return {
        name: dirty.current.has('name') ? f.name : fresh.name,
        quantity: dirty.current.has('quantity') ? f.quantity : fresh.quantity,
        note: dirty.current.has('note') ? f.note : fresh.note,
      };
    });
  }, [item]);

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const f = fieldsRef.current;
    const cur = last.current;
    if (!engine || !f || !cur || dirty.current.size === 0) return;
    const out: { name?: string; quantity?: number; unit?: Unit; note?: string } = {};
    if (dirty.current.has('name')) {
      const name = cleanItemName(f.name);
      if (!name) {
        setNameError('Een item heeft een naam nodig.');
      } else {
        setNameError(null);
        if (name !== cur.name) out.name = name;
        dirty.current.delete('name');
      }
    }
    if (dirty.current.has('quantity')) {
      const q = parseQuantityField(f.quantity);
      if (!q) {
        setQtyError(QUANTITY_HINT);
      } else {
        setQtyError(null);
        if (q.quantity !== cur.quantity) out.quantity = q.quantity;
        if (q.unit !== cur.unit) out.unit = q.unit;
        dirty.current.delete('quantity');
      }
    }
    if (dirty.current.has('note')) {
      const note = f.note.slice(0, LIMITS.noteMaxLength);
      if (note !== cur.note) out.note = note;
      dirty.current.delete('note');
    }
    if (Object.keys(out).length > 0) await engine.updateItem(cur.id, out).catch(() => undefined);
  }, [engine]);
  useLayoutEffect(() => {
    saveRef.current = save;
  });

  // Deleted elsewhere while open: close with "… Terugzetten". An add the server merged into another
  // row is not gone: useItem follows the alias, and the sheet stays open on the merged row.
  useEffect(() => {
    if (itemId && !item && last.current && !deletingRef.current) {
      void save(); // keep what was typed (the engine ignores edits of a deleted row; a restore keeps them)
      const gone = last.current;
      last.current = null;
      onGone(gone);
    }
  }, [item, itemId, onGone, save]);

  // Unmount (another item opened, screen left): flush a pending save instead of dropping it.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        void saveRef.current();
      }
    },
    [],
  );

  const change = (key: keyof Fields, text: string) => {
    dirty.current.add(key);
    setFields((f) => (f ? { ...f, [key]: text } : f));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
  };

  const close = () => {
    void save();
    onClose();
  };

  const visible = !!itemId && !!item && !!fields;
  return (
    <BottomSheet visible={visible} onClose={close} accessibilityLabel={item ? `Details van ${item.name}` : 'Details'} testID="item-sheet">
      {item && fields ? (
        <View style={styles.form}>
          <TextField
            value={fields.name}
            onChangeText={(t) => change('name', t)}
            onBlur={() => void save()}
            accessibilityLabel="Naam"
            maxLength={LIMITS.nameMaxLength}
            returnKeyType="done"
            error={nameError}
            testID="detail-name"
            style={styles.name}
          />
          <TextField
            label="Hoeveelheid"
            value={fields.quantity}
            onChangeText={(t) => change('quantity', t)}
            onBlur={() => void save()}
            placeholder="1"
            autoCapitalize="none"
            autoCorrect={false}
            error={qtyError}
            testID="detail-quantity"
          />
          <TextField
            label="Notitie"
            value={fields.note}
            onChangeText={(t) => change('note', t)}
            onBlur={() => void save()}
            maxLength={LIMITS.noteMaxLength}
            hint={fields.note.length > LIMITS.noteMaxLength - 20 ? `${fields.note.length} van ${LIMITS.noteMaxLength} tekens` : null}
            testID="detail-note"
          />
          <AppText variant="footnote" color="textMuted">
            {addedByText(item, members, me)}
          </AppText>
          <TextButton
            label="Verwijderen"
            tone="danger"
            onPress={() => {
              deletingRef.current = true;
              if (timer.current) clearTimeout(timer.current);
              dirty.current.clear();
              onDeleted(item);
            }}
          />
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  name: { fontWeight: '600' },
});
