/**
 * "Goedkoopste route" (design-spec 4.5). v1 has no licensed source, so the screen shows
 * "Geen geverifieerde prijzen beschikbaar" with no button and no toggle. When verified data for at
 * least two chains exists, the engine result is rendered honestly: only complete single-store
 * baskets get an amount and a rank; incomplete ones show "10 van 12 prijzen"; unknown is never €0.
 */
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { BasketLine, BasketRequestItem, ComparisonResult, PriceSource, StoreBasket, VisibleItem } from '@/src/contracts';
import {
  compareBaskets,
  DAY_MS,
  formatAge,
  formatBasketTotal,
  formatCents,
  formatCoverage,
  formatDelta,
  formatLineAmount,
  formatOverage,
  formatPackages,
  formatPromotion,
  formatResultHeader,
  formatStoreLabel,
  isEligibleSource,
  listFingerprint,
  PRICE_COPY,
  statusForAge,
} from '@/src/price';
import { useList, useSyncEngine } from '@/src/sync/hooks';
import {
  AppText,
  BottomSheet,
  ClockIcon,
  Divider,
  EmptyState,
  IconButton,
  InfoIcon,
  QuestionIcon,
  ReceiptIcon,
  ScreenHeader,
  SkeletonRows,
  TextButton,
  useColors,
} from '@/src/ui';
import { sizes, spacing } from '@/src/ui/tokens';

import type { AppEngine } from '@/src/lib/backend/types';
import { formatWhen } from '../list/time';
import { usePrices } from './PriceContext';

export const UNAVAILABLE_BODY = `We vergelijken pas als we betrouwbare prijzen hebben. ${PRICE_COPY.unavailableBody}`;

export function toBasketItems(items: readonly VisibleItem[]): BasketRequestItem[] {
  return items.map((i) => ({
    list_item_id: i.id,
    name: i.name,
    normalized_name: i.normalized_name,
    quantity: i.quantity,
    unit: i.unit,
    excluded: i.exclude_from_comparison,
  }));
}

/** "38 euro 42" for screen readers. */
export function speakCents(cents: number): string {
  const euros = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? `${euros} euro` : `${euros} euro ${rest}`;
}

/** "Jumbo, 12 van 12 prijzen, 1 verouderd, goedkoopste, 38 euro 42." / "Lidl, onvolledig, 10 van 12 prijzen." */
export function storeAccessibilityLabel(b: StoreBasket, showLabel: boolean): string {
  const coverage = formatCoverage(b);
  if (!b.complete || b.total_cents === null) return `${b.chain_name}, onvolledig, ${coverage}.`;
  const parts = [b.chain_name, coverage];
  if (b.stale_count > 0) parts.push(`${b.stale_count} verouderd`);
  if (showLabel && b.label === 'cheapest') parts.push('goedkoopste');
  if (showLabel && b.label === 'tied') parts.push('even goedkoop');
  if (showLabel && b.label === 'only_complete') parts.push('enige complete mand');
  parts.push(speakCents(b.total_cents));
  return `${parts.join(', ')}.`;
}

export function RouteScreen() {
  const c = useColors();
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]} edges={['top']}>
      <RouteBody />
    </SafeAreaView>
  );
}

function Title({ onInfo }: { onInfo?: () => void }) {
  return (
    <ScreenHeader
      title={PRICE_COPY.title}
      subtitle={PRICE_COPY.subtitle}
      right={
        onInfo ? (
          <IconButton label="Hoe we vergelijken" onPress={onInfo} testID="route-info">
            <InfoIcon size={22} color="textMuted" />
          </IconButton>
        ) : null
      }
    />
  );
}

/**
 * A cached comparison (offline, rule 9) is shown only while it is still true: at most 12 h old, every
 * priced line still has the status it was cached with (a price that has meanwhile passed 7 days would
 * be "verouderd", past 14 days unknown), and no applied promotion has ended. Ages use the exact
 * observation time; a cache without it uses the upper bound of its floored age_days. Otherwise the
 * error state is shown instead of old totals and an old "Goedkoopste".
 */
export const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export function isCachedComparisonUsable(result: ComparisonResult, computedAt: number, now: number): boolean {
  const elapsed = now - computedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > CACHE_MAX_AGE_MS) return false;
  for (const store of result.stores) {
    for (const line of store.lines) {
      if (line.status === 'unknown') continue;
      const observed = line.observed_at ? Date.parse(line.observed_at) : NaN;
      const ageNow = Number.isFinite(observed) ? now - observed : line.age_days === null ? Infinity : (line.age_days + 1) * DAY_MS + elapsed;
      if (statusForAge(ageNow) !== line.status) return false;
      if (line.promotion_applied && line.promotion_valid_until && Date.parse(line.promotion_valid_until) < now) return false;
    }
  }
  return true;
}

function RouteBody() {
  const router = useRouter();
  const prices = usePrices();
  const engine = useSyncEngine() as AppEngine | null;
  const snapshot = useList();
  const [cached, setCached] = useState<{ result: ComparisonResult; computedAt: number } | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  // Price ages are in whole days: refreshing "now" once a minute is plenty.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const items = useMemo(() => toBasketItems([...snapshot.open, ...snapshot.checked]), [snapshot.open, snapshot.checked]);
  const fingerprint = useMemo(() => listFingerprint(items), [items]);
  const live = useMemo<ComparisonResult | null>(() => {
    if (prices.status !== 'ready' || !prices.dataset) return null;
    return compareBaskets({ items, data: prices.dataset, now, list_fingerprint: fingerprint });
  }, [prices.status, prices.dataset, items, fingerprint, now]);

  // Keep the last comparison with the list revision (rule 9) for offline use.
  const lastWritten = useRef<string | null>(null);
  useEffect(() => {
    if (!engine?.writePriceCache || !live || (live.state !== 'ranked' && live.state !== 'no_complete')) return;
    const key = `${live.list_fingerprint}:${live.computed_at}`;
    if (lastWritten.current === key) return;
    lastWritten.current = key;
    void engine.writePriceCache({ result: live, listFingerprint: live.list_fingerprint, computedAt: live.computed_at }).catch(() => undefined);
  }, [engine, live]);

  useEffect(() => {
    if (prices.status !== 'error' || !engine?.readPriceCache) return;
    let alive = true;
    void engine.readPriceCache().then((e) => {
      if (alive && e && typeof e.result === 'object' && e.result) setCached({ result: e.result as ComparisonResult, computedAt: e.computedAt });
    });
    return () => {
      alive = false;
    };
  }, [engine, prices.status]);

  const sources = prices.dataset?.sources ?? [];

  if (prices.status === 'idle' || prices.status === 'loading' || !snapshot.loaded) {
    return (
      <>
        <Title />
        <SkeletonRows />
      </>
    );
  }

  if (prices.status === 'error') {
    if (cached && prices.optIn && isCachedComparisonUsable(cached.result, cached.computedAt, now)) {
      return (
        <ResultView
          result={cached.result}
          stale={{ since: cached.computedAt, changed: cached.result.list_fingerprint !== fingerprint }}
          sources={sources}
          onInfo={() => setInfoOpen(true)}
          infoOpen={infoOpen}
          onCloseInfo={() => setInfoOpen(false)}
        />
      );
    }
    return (
      <>
        <Title />
        <EmptyState
          icon={<ReceiptIcon size={40} color="textMuted" />}
          title="Prijzen tijdelijk niet beschikbaar"
          body="Je lijst werkt gewoon."
          action={{ label: 'Opnieuw proberen', onPress: prices.reload }}
          testID="route-error"
        />
      </>
    );
  }

  if (!live || live.state === 'unavailable') {
    return (
      <>
        <Title />
        <EmptyState icon={<ReceiptIcon size={40} color="textMuted" />} title={PRICE_COPY.unavailableTitle} body={UNAVAILABLE_BODY} testID="route-unavailable" />
      </>
    );
  }

  if (!prices.optIn) {
    // Same empty-tab layout as the no-data state (D-15), saying what the tap does and which source.
    const names = sources.filter(isEligibleSource).map((s) => s.name);
    return (
      <>
        <Title />
        <EmptyState
          icon={<ReceiptIcon size={40} color="textMuted" />}
          title="Vergelijk je lijst per winkel"
          body={`We tellen per winkel je hele lijst op${names.length ? `, met prijzen van ${names.join(' en ')}` : ''}. ${PRICE_COPY.optInBody}`}
          action={{ label: PRICE_COPY.optInButton, onPress: () => void prices.setOptIn(true) }}
          actionStyle="primary"
          testID="route-opt-in"
        />
      </>
    );
  }

  if (live.state === 'empty') {
    return (
      <>
        <Title />
        <EmptyState
          icon={<ReceiptIcon size={40} color="textMuted" />}
          title={PRICE_COPY.empty}
          body="Voeg items toe aan je lijst."
          action={{ label: 'Naar Mijn lijst', onPress: () => router.navigate('/') }}
          testID="route-empty"
        />
      </>
    );
  }

  return <ResultView result={live} sources={sources} onInfo={() => setInfoOpen(true)} infoOpen={infoOpen} onCloseInfo={() => setInfoOpen(false)} />;
}

function ResultView({
  result,
  stale,
  sources,
  onInfo,
  infoOpen,
  onCloseInfo,
}: {
  result: ComparisonResult;
  stale?: { since: number; changed: boolean };
  sources: PriceSource[];
  onInfo(): void;
  infoOpen: boolean;
  onCloseInfo(): void;
}) {
  const engine = useSyncEngine();
  const snapshot = useList();
  const [storeId, setStoreId] = useState<string | null>(null);
  const complete = result.stores.filter((s) => s.complete && s.total_cents !== null);
  const incomplete = result.stores.filter((s) => !(s.complete && s.total_cents !== null));
  // The "Goedkoopste" label disappears when the list changed since the cached comparison (rule 9).
  const showLabels = !stale?.changed;
  const store = result.stores.find((s) => s.chain_id === storeId) ?? null;
  const used = sources.filter((s) => result.source_ids.includes(s.id));
  const webshop = used.some((s) => s.channel === 'webshop');

  // Items without a price at any store can be excluded for all stores at once (P17).
  const unpricedEverywhere = useMemo(() => {
    if (result.state !== 'no_complete' || result.stores.length === 0) return [];
    const ids = result.stores[0]!.lines.filter((l) => result.stores.every((s) => s.lines.find((x) => x.list_item_id === l.list_item_id)?.status === 'unknown')).map((l) => l.list_item_id);
    return ids.map((id) => ({ id, name: result.stores[0]!.lines.find((l) => l.list_item_id === id)!.item_name }));
  }, [result]);
  const excluded = [...snapshot.open, ...snapshot.checked].filter((i) => i.exclude_from_comparison);

  return (
    <>
      <Title onInfo={onInfo} />
      <ScrollView contentContainerStyle={styles.scroll} testID="route-result">
        <AppText variant="footnote" color="textMuted" style={styles.header}>
          {formatResultHeader(result)}
        </AppText>
        {stale ? (
          <AppText variant="footnote" color="textMuted" style={styles.header}>
            {stale.changed ? `Je lijst is gewijzigd sinds ${formatWhen(new Date(stale.since).toISOString())}` : `Van ${formatWhen(new Date(stale.since).toISOString())}`}
          </AppText>
        ) : null}
        {result.state === 'no_complete' ? (
          <AppText variant="body" style={[styles.header, styles.noComplete]}>
            {PRICE_COPY.noComplete}
          </AppText>
        ) : null}
        {complete.map((b) => (
          <StoreRow key={b.chain_id} basket={b} showLabel={showLabels} onPress={() => setStoreId(b.chain_id)} />
        ))}
        {incomplete.length > 0 ? (
          <>
            <AppText variant="footnote" color="textMuted" style={styles.sectionHead}>
              {PRICE_COPY.incompleteHeader}
            </AppText>
            {incomplete.map((b) => (
              <StoreRow key={b.chain_id} basket={b} showLabel={false} onPress={() => setStoreId(b.chain_id)} />
            ))}
          </>
        ) : null}
        {unpricedEverywhere.length > 0 && engine ? (
          <View style={styles.block}>
            <AppText variant="footnote" color="textMuted">
              Geen enkele winkel heeft een prijs voor:
            </AppText>
            {unpricedEverywhere.map((u) => (
              <View key={u.id} style={styles.lineRow}>
                <AppText variant="body" style={styles.flex}>
                  {u.name}
                </AppText>
                <TextButton label={PRICE_COPY.exclude} accessibilityLabel={`${u.name} niet vergelijken`} onPress={() => void engine.updateItem(u.id, { exclude_from_comparison: true })} />
              </View>
            ))}
          </View>
        ) : null}
        {excluded.length > 0 && engine ? (
          <View style={styles.block}>
            <AppText variant="footnote" color="textMuted">
              Uitgesloten
            </AppText>
            {excluded.map((i) => (
              <View key={i.id} style={styles.lineRow}>
                <AppText variant="body" color="textMuted" style={styles.flex}>
                  {i.name}
                </AppText>
                <TextButton label="Toch vergelijken" accessibilityLabel={`${i.name} toch vergelijken`} onPress={() => void engine.updateItem(i.id, { exclude_from_comparison: false })} />
              </View>
            ))}
          </View>
        ) : null}
        <AppText variant="footnote" color="textMuted" style={styles.footer}>
          {webshop ? PRICE_COPY.webshopFootnote : 'Dit zijn landelijke prijzen. In de winkel kan het anders zijn.'}
        </AppText>
      </ScrollView>
      <StoreSheet basket={store} onClose={() => setStoreId(null)} />
      <BottomSheet visible={infoOpen} onClose={onCloseInfo} title="Hoe we vergelijken" testID="route-info-sheet">
        <AppText variant="body">
          {`We gebruiken ${used.map((s) => `${s.channel === 'webshop' ? 'webshopprijzen' : 'landelijke prijzen'} via ${s.name}`).join(', ') || 'geverifieerde bronnen'}. Elke prijs heeft een datum. Voor elk item vergelijken we bij elke winkel hetzelfde soort product en dezelfde hoeveelheid. Ontbreekt een prijs, dan tellen we die niet als nul en noemen we de mand onvolledig. Statiegeld telt niet mee. Prijzen kunnen in de winkel afwijken.`}
        </AppText>
      </BottomSheet>
    </>
  );
}

function StoreRow({ basket, showLabel, onPress }: { basket: StoreBasket; showLabel: boolean; onPress(): void }) {
  const c = useColors();
  const total = formatBasketTotal(basket);
  const label = showLabel ? formatStoreLabel(basket) : basket.complete && basket.stale_count > 0 ? `${basket.stale_count} verouderd` : null;
  const delta = formatDelta(basket.delta_cents);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={storeAccessibilityLabel(basket, showLabel)}
      accessibilityHint="Toont de prijzen per item"
      testID={`store-${basket.chain_id}`}
      style={({ pressed }) => [styles.store, { borderBottomColor: c.border, backgroundColor: pressed ? c.surface : 'transparent' }]}>
      <View style={styles.storeLine}>
        <AppText variant="body" style={styles.flex}>
          {basket.chain_name}
        </AppText>
        {total !== null ? (
          <AppText variant="bodyStrong" tabular>
            {total}
          </AppText>
        ) : (
          <AppText variant="callout" color="textMuted" tabular>
            {formatCoverage(basket)}
          </AppText>
        )}
      </View>
      {label || (delta && total !== null) ? (
        <View style={styles.storeLine}>
          <AppText variant="footnote" color="textMuted" style={styles.flex}>
            {label ?? ''}
          </AppText>
          {delta && total !== null ? (
            <AppText variant="callout" color="textMuted" tabular>
              {delta}
            </AppText>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function StoreSheet({ basket, onClose }: { basket: StoreBasket | null; onClose(): void }) {
  const prices = usePrices();
  const [line, setLine] = useState<BasketLine | null>(null);
  const overridden = (l: BasketLine) =>
    !!basket && !!l.catalog_item_id && !!prices.dataset?.overrides.some((o) => o.catalog_item_id === l.catalog_item_id && o.chain_id === basket.chain_id);
  return (
    <>
      <BottomSheet visible={!!basket && !line} onClose={onClose} title={basket?.chain_name} testID="store-sheet">
        {basket ? (
          <AppText variant="footnote" color="textMuted" testID="store-sheet-summary" style={styles.sheetSummary}>
            {storeSummary(basket)}
          </AppText>
        ) : null}
        {basket?.lines.map((l) => (
          <LineRow key={l.list_item_id} line={l} onPress={l.catalog_item_id && (l.status !== 'unknown' || overridden(l)) ? () => setLine(l) : undefined} />
        ))}
      </BottomSheet>
      <BottomSheet visible={!!basket && !!line} onClose={() => setLine(null)} title={line?.product_name ?? line?.item_name} testID="line-sheet">
        {line && basket && line.catalog_item_id ? (
          overridden(line) ? (
            <TextButton
              label={PRICE_COPY.useAnyway}
              onPress={async () => {
                await prices.setOverride(line.catalog_item_id!, basket.chain_id, false).catch(() => undefined);
                setLine(null);
              }}
            />
          ) : (
            <TextButton
              label={PRICE_COPY.wrongProduct}
              tone="danger"
              onPress={async () => {
                await prices.setOverride(line.catalog_item_id!, basket.chain_id, true).catch(() => undefined);
                setLine(null);
              }}
            />
          )
        ) : null}
      </BottomSheet>
    </>
  );
}

/** Store sheet subtitle (D-14): "€4,59 · 2 van 2 prijzen · 1 verouderd" / "Onvolledig · 1 van 2 prijzen". */
export function storeSummary(b: StoreBasket): string {
  const total = formatBasketTotal(b);
  if (!b.complete || total === null) return `${PRICE_COPY.incompleteHeader} · ${formatCoverage(b)}`;
  return [total, formatCoverage(b), b.stale_count > 0 ? `${b.stale_count} verouderd` : null].filter(Boolean).join(' · ');
}

function LineRow({ line, onPress }: { line: BasketLine; onPress?: () => void }) {
  const unknown = line.status === 'unknown' || line.line_total_cents === null;
  const age = formatAge(line);
  const overage = formatOverage(line);
  const promotion = unknown ? null : formatPromotion(line);
  const packages = formatPackages(line);
  const title = line.product_name ?? line.item_name;
  const spoken = [title, packages ? `${line.package_count} keer` : null, unknown ? 'geen prijs' : formatCents(line.line_total_cents!), promotion, age, overage].filter(Boolean).join(', ');
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole={onPress ? 'button' : undefined} accessibilityLabel={spoken} style={styles.line}>
      <View style={styles.lineRow}>
        <AppText variant="body" style={styles.flex}>
          {title}
        </AppText>
        {packages ? (
          <AppText variant="callout" color="textMuted" tabular>
            {packages}
          </AppText>
        ) : null}
        {unknown ? (
          <View style={styles.inline}>
            <QuestionIcon size={16} color="textMuted" />
            <AppText variant="callout" color="textMuted">
              {PRICE_COPY.noPrice}
            </AppText>
          </View>
        ) : (
          <AppText variant="bodyStrong" tabular>
            {formatLineAmount(line)}
          </AppText>
        )}
      </View>
      {age || overage || promotion ? (
        <View style={styles.inline}>
          {promotion ? (
            <AppText variant="footnote" color="textMuted" testID="line-promotion">
              {promotion}
            </AppText>
          ) : null}
          {age ? (
            <>
              <ClockIcon size={14} color="warning" />
              <AppText variant="footnote" color="warning">
                {age}
              </AppText>
            </>
          ) : null}
          {overage ? (
            <AppText variant="footnote" color="textMuted">
              {overage}
            </AppText>
          ) : null}
        </View>
      ) : null}
      <Divider style={styles.lineDivider} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  sheetSummary: { marginBottom: spacing.xs },
  scroll: { paddingBottom: spacing.xxl * 3 },
  header: { paddingHorizontal: sizes.sideMargin, marginBottom: spacing.sm },
  noComplete: { marginTop: spacing.sm },
  sectionHead: { paddingHorizontal: sizes.sideMargin, paddingTop: spacing.lg, paddingBottom: spacing.xs },
  store: { paddingHorizontal: sizes.sideMargin, paddingVertical: spacing.md, minHeight: sizes.rowMinHeight, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
  storeLine: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.md },
  flex: { flex: 1 },
  block: { paddingHorizontal: sizes.sideMargin, paddingTop: spacing.lg, gap: spacing.xs },
  footer: { paddingHorizontal: sizes.sideMargin, paddingTop: spacing.xl },
  line: { paddingTop: spacing.sm, gap: 2 },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 32 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  lineDivider: { marginTop: spacing.sm, marginBottom: spacing.xs },
});
