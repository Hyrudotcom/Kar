/**
 * Dutch display helpers for the "Goedkoopste route" tab (design-spec 4.5). Pure string functions;
 * the screens (mobile builder) decide layout. A null amount is NEVER formatted as €0,00.
 */
import type { BaseUnit, BasketLine, ComparisonResult, StoreBasket } from '@/src/contracts';

export const PRICE_COPY = {
  title: 'Goedkoopste route',
  subtitle: 'Welke winkel is voor je hele lijst het goedkoopst',
  unavailableTitle: 'Geen geverifieerde prijzen beschikbaar',
  unavailableBody: 'We laten liever niets zien dan een verkeerde vergelijking.',
  empty: 'Nog niets te vergelijken',
  noComplete: 'Geen winkel heeft al je prijzen',
  incompleteHeader: 'Onvolledig',
  cheapest: 'Goedkoopste',
  onlyComplete: 'Enige complete mand',
  noPrice: 'Geen prijs',
  wrongProduct: 'Verkeerd product',
  useAnyway: 'Toch gebruiken',
  exclude: 'Niet vergelijken',
  optInBody: 'Ontbrekende prijzen tonen we eerlijk.',
  optInButton: 'Prijzen vergelijken',
  webshopFootnote: 'Webshopprijzen, kunnen in de winkel afwijken.',
} as const;

/** 3842 -> "€38,42"; 5 -> "€0,05". Throws on a non-integer so a missing price can never render as €0,00. */
export function formatCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error('formatCents: amount must be integer cents');
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}€${euros},${(abs % 100).toString().padStart(2, '0')}`;
}

/** Delta to the cheapest basket: "+€2,68". null for the cheapest / incomplete ones. */
export function formatDelta(delta: number | null): string | null {
  return delta === null ? null : `+${formatCents(delta)}`;
}

/** Basket amount, or null when the basket is incomplete (no total is shown at all). */
export function formatBasketTotal(b: StoreBasket): string | null {
  return b.complete && b.total_cents !== null ? formatCents(b.total_cents) : null;
}

/** "10 van 12 prijzen" (design-spec 4.5 incomplete row). */
export function formatCoverage(b: StoreBasket): string {
  return `${b.priced_count} van ${b.compared_count} prijzen`;
}

/** "2 van 12 zonder prijs" (price verdict wording). */
export function formatMissing(b: StoreBasket): string {
  return `${b.compared_count - b.priced_count} van ${b.compared_count} zonder prijs`;
}

/** "4 d oud" for stale lines; null for verified/unknown lines. */
export function formatAge(line: BasketLine): string | null {
  return line.status === 'stale' && line.age_days !== null ? `${line.age_days} d oud` : null;
}

/** Store row subtitle: "Goedkoopste · 1 verouderd", "Enige complete mand", "1 verouderd" or null. */
export function formatStoreLabel(b: StoreBasket): string | null {
  const parts: string[] = [];
  if (b.label === 'cheapest') parts.push(PRICE_COPY.cheapest);
  if (b.label === 'only_complete') parts.push(PRICE_COPY.onlyComplete);
  if (b.complete && b.stale_count > 0) parts.push(`${b.stale_count} verouderd`);
  return parts.length ? parts.join(' · ') : null;
}

function decimalNl(n: number): string {
  return (Math.round(n * 1000) / 1000).toString().replace('.', ',');
}

/** 600 g -> "600 g", 1500 g -> "1,5 kg", 900 ml -> "900 ml", 2 stuk -> "2 stuks". */
export function formatAmount(amount: number, unit: BaseUnit): string {
  if (unit === 'g') return amount >= 1000 ? `${decimalNl(amount / 1000)} kg` : `${decimalNl(amount)} g`;
  if (unit === 'ml') return amount >= 1000 ? `${decimalNl(amount / 1000)} l` : `${decimalNl(amount)} ml`;
  return `${decimalNl(amount)} ${amount === 1 ? 'stuk' : 'stuks'}`;
}

/** Item line packaging: "2×", or null when there is no price. */
export function formatPackages(line: BasketLine): string | null {
  return line.package_count === null ? null : `${line.package_count}×`;
}

/** "600 g, 100 g meer" (only set when the engine reported > 25% overage). */
export function formatOverage(line: BasketLine): string | null {
  if (!line.overage || line.package_count === null || line.package_content === null || line.package_unit === null) return null;
  const totalBought = Math.round(line.package_count * line.package_content * 1000) / 1000;
  return `${formatAmount(totalBought, line.package_unit)}, ${formatAmount(line.overage.amount, line.overage.unit)} meer`;
}

/** Line amount: "€2,38" or "Geen prijs" — never "€0,00" for an unknown price. */
export function formatLineAmount(line: BasketLine): string {
  return line.status !== 'unknown' && line.line_total_cents !== null ? formatCents(line.line_total_cents) : PRICE_COPY.noPrice;
}

/** Header: "12 items · oudste prijs 4 d" or "11 van 12 items vergeleken · 1 uitgesloten". */
export function formatResultHeader(r: ComparisonResult): string {
  const total = r.compared_count + r.excluded_count;
  const parts: string[] = [];
  if (r.excluded_count > 0) {
    parts.push(`${r.compared_count} van ${total} items vergeleken`, `${r.excluded_count} uitgesloten`);
  } else {
    parts.push(`${r.compared_count} ${r.compared_count === 1 ? 'item' : 'items'}`);
  }
  if (r.oldest_price_age_days !== null) parts.push(`oudste prijs ${r.oldest_price_age_days} d`);
  return parts.join(' · ');
}
