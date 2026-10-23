/**
 * "Mijn lijst" (design-spec 4.3): compact header, quick-add bar with local suggestions, open items
 * (newest first), collapsible "Afgevinkt (n)". Nothing moves under the user's finger.
 */
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { FlatList, Keyboard, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { ParsedEntry, VisibleItem } from '@/src/contracts';
import type { AppEngine } from '@/src/lib/backend/types';
import { hapticLight, hapticMedium } from '@/src/lib/haptics';
import { normalizeName } from '@/src/shared/normalize';
import { formatIncrement, parseEntry } from '@/src/shared/quantity';
import { useHistory, useList, useSyncStatus } from '@/src/sync/hooks';
import { EmptyState, SkeletonRows, useColors, useReducedMotion } from '@/src/ui';
import { spacing } from '@/src/ui/tokens';

import { useSnackbar } from '../feedback/SnackbarProvider';
import { useBackend } from '../session/BackendContext';
import { useReadySession } from '../session/SessionProvider';
import { getSuggestionIndex, type Suggestion } from '../suggestions/search';
import { CheckedHeader } from './CheckedSection';
import { ItemDetailSheet } from './ItemDetailSheet';
import { ListHeader } from './ListHeader';
import { ListRow } from './ListRow';
import { QuickAddBar } from './QuickAddBar';
import { SuggestionList } from './SuggestionList';
import { SyncIndicator } from './SyncIndicator';
import { useStableList } from './useStableList';

type Row = { kind: 'item'; item: VisibleItem } | { kind: 'checkedHeader' } | { kind: 'allChecked' };

export function ListScreen() {
  const { engine, household, user } = useReadySession();
  return <ListScreenBody engine={engine} householdName={household.name} members={household.members} me={user.id} />;
}

function ListScreenBody({ engine, householdName, members, me }: { engine: AppEngine; householdName: string; members: ReturnType<typeof useReadySession>['household']['members']; me: string }) {
  const c = useColors();
  const router = useRouter();
  const backend = useBackend();
  const snackbar = useSnackbar();
  const reduced = useReducedMotion();
  const snapshot = useList();
  const status = useSyncStatus();
  const history = useHistory();
  const stable = useStableList(snapshot, reduced);

  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const inputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const listRef = useRef<FlatList<Row>>(null);
  const autofocused = useRef(false);

  // Empty list: cursor in the bar. Non-empty: keyboard stays closed (design-spec 0.1).
  useEffect(() => {
    if (!snapshot.loaded || autofocused.current) return;
    autofocused.current = true;
    if (snapshot.open.length === 0 && snapshot.checked.length === 0) setTimeout(() => inputRef.current?.focus(), 50);
  }, [snapshot.loaded, snapshot.open.length, snapshot.checked.length]);

  const entry = useMemo(() => parseEntry(text), [text]);
  const suggestions = useMemo(
    () => (entry ? getSuggestionIndex().suggest(entry.name, { checked: snapshot.checked, history }) : []),
    [entry, snapshot.checked, history],
  );

  const add = useCallback(
    async (e: ParsedEntry, picked?: Suggestion) => {
      let name = picked ? picked.name : e.name;
      let { quantity, unit } = e;
      if (!e.explicitQuantity) {
        // Typing a checked item's name brings that row back with its own quantity (design-spec 4.3).
        const norm = normalizeName(name);
        const match = picked?.item ?? snapshot.checked.find((i) => i.normalized_name === norm || normalizeName(i.name) === norm);
        if (match) {
          name = match.name;
          quantity = match.quantity;
          unit = match.unit;
        }
      }
      const typed = text;
      setText('');
      try {
        const r = await engine.addItem({ name, quantity, unit });
        if (r.outcome === 'noop') {
          // Nothing was stored: never lose what was typed without a word.
          setText(typed);
          snackbar.show({ message: 'Dit item kon niet worden toegevoegd.' });
          return;
        }
        if (r.outcome === 'merged') {
          // Quick repeated merges add up in one snackbar; one undo takes them all back (design-spec 3).
          const itemName = r.itemName;
          snackbar.show({
            message: `${itemName} ${formatIncrement(quantity, unit)}`,
            group: `merge:${r.itemId}:${unit}`,
            count: quantity,
            groupMessage: (n) => `${itemName} ${formatIncrement(n, unit)}`,
            onAction: () => engine.undo(r.undo),
          });
        } else if (r.outcome === 'restored') {
          snackbar.show({ message: `${r.itemName} teruggezet`, onAction: () => engine.undo(r.undo) });
        }
        listRef.current?.scrollToOffset({ offset: 0, animated: !reduced });
      } catch {
        snackbar.show({ message: 'Dit item kon niet worden toegevoegd.' });
      }
    },
    [engine, snackbar, snapshot.checked, reduced, text],
  );

  const submit = useCallback(() => {
    if (entry) void add(entry);
  }, [entry, add]);

  const toggle = useCallback(
    (item: VisibleItem) => {
      hapticLight();
      stable.onCheckTap();
      void engine.setChecked(item.id, !item.checked).catch(() => undefined);
    },
    [engine, stable],
  );

  const remove = useCallback(
    async (item: VisibleItem) => {
      hapticMedium();
      try {
        const r = await engine.deleteItem(item.id);
        if (r.outcome === 'noop') return; // nothing deleted: no "verwijderd · Ongedaan maken"
        snackbar.show({
          message: `${r.itemName || item.name} verwijderd`,
          group: 'delete',
          groupMessage: (n) => `${n} items verwijderd`,
          onAction: () => engine.undo(r.undo),
        });
      } catch {
        /* refusals surface through the sync icon */
      }
    },
    [engine, snackbar],
  );

  const clearChecked = useCallback(async () => {
    // Exactly the checked rows on screen right now, by id (design-spec 4.3, F15).
    const ids = stable.checked.filter((i) => i.checked).map((i) => i.id);
    if (ids.length === 0) return;
    hapticMedium();
    const results = await engine.clearChecked(ids).catch(() => []);
    if (results.length === 0) return;
    snackbar.show({
      message: results.length === 1 ? `${results[0]!.itemName} gewist` : `${results.length} items gewist`,
      onAction: () => engine.undo(results.flatMap((r) => r.undo)),
    });
  }, [engine, snackbar, stable.checked]);

  const openDetail = useCallback((item: VisibleItem) => {
    Keyboard.dismiss();
    setDetailId(item.id);
  }, []);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = stable.open.map((item) => ({ kind: 'item', item }));
    if (stable.checked.length > 0) {
      if (stable.open.length === 0) out.push({ kind: 'allChecked' });
      out.push({ kind: 'checkedHeader' });
      if (expanded) for (const item of stable.checked) out.push({ kind: 'item', item });
    }
    return out;
  }, [stable.open, stable.checked, expanded]);

  const renderItem = useCallback(
    ({ item: row }: { item: Row }) => {
      if (row.kind === 'checkedHeader') {
        return <CheckedHeader count={stable.checked.length} expanded={expanded} onToggle={() => setExpanded((e) => !e)} onClear={() => void clearChecked()} />;
      }
      if (row.kind === 'allChecked') {
        // One "Wissen" only: the checked header right below carries it (design-spec 3).
        return <EmptyState title="Alles afgevinkt" body="Klaar met boodschappen?" testID="all-checked" />;
      }
      return (
        <ListRow
          item={row.item}
          onToggle={toggle}
          onOpen={openDetail}
          onDelete={remove}
          onSwipeStart={stable.onInteractionStart}
          onSwipeEnd={stable.onInteractionEnd}
        />
      );
    },
    [stable.checked.length, stable.onInteractionStart, stable.onInteractionEnd, expanded, clearChecked, toggle, openDetail, remove],
  );

  const engineName = engine.getHousehold()?.name;
  const name = engineName || householdName;
  const typing = !!entry;
  const empty = snapshot.loaded && snapshot.open.length === 0 && snapshot.checked.length === 0;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]} edges={['top']}>
      <ListHeader
        name={name}
        onHousehold={() => router.push('/household')}
        sync={
          <SyncIndicator
            status={status}
            failedText={() => engine.failedAsText()}
            onDiscard={(ids) => void engine.discardFailed(ids)}
            onReauth={() => void backend.auth.signOut()}
          />
        }
      />
      <QuickAddBar ref={inputRef} value={text} onChangeText={setText} onSubmit={submit} />
      {typing && entry ? (
        <SuggestionList entry={entry} suggestions={suggestions} onAddTyped={submit} onPick={(s) => void add(entry, s)} />
      ) : null}
      <View style={[styles.listWrap, typing ? styles.hidden : null]}>
        {!snapshot.loaded ? (
          <SkeletonRows />
        ) : empty ? (
          // No illustration: the tab icon reused as artwork read as a button (D4-14, as on the route).
          <EmptyState title="Je lijst is leeg" body="Typ hierboven wat je nodig hebt." testID="empty-list" />
        ) : (
          <FlatList
            ref={listRef}
            data={rows}
            keyExtractor={(r) => (r.kind === 'item' ? r.item.id : r.kind)}
            renderItem={renderItem}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            onTouchStart={stable.onInteractionStart}
            onTouchEnd={stable.onInteractionEnd}
            onTouchCancel={stable.onInteractionEnd}
            onScrollBeginDrag={stable.onInteractionStart}
            onMomentumScrollBegin={stable.onInteractionStart}
            onMomentumScrollEnd={stable.onInteractionEnd}
            contentContainerStyle={styles.content}
            testID="list"
          />
        )}
      </View>
      <ItemDetailSheet
        key={detailId ?? 'none'}
        itemId={detailId}
        members={members}
        me={me}
        onClose={() => setDetailId(null)}
        onDeleted={(item) => {
          setDetailId(null);
          void remove(item);
        }}
        onGone={(item) => {
          setDetailId(null);
          snackbar.show({ message: `${item.name} is verwijderd`, actionLabel: 'Terugzetten', onAction: () => engine.restoreItem(item.id).then(() => undefined) });
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  listWrap: { flex: 1 },
  hidden: { display: 'none' },
  content: { paddingBottom: spacing.xxl * 3 },
});
