/**
 * Quick-add parser and quantity formatting (design-spec 3 QuickAddBar, 4.4 item detail).
 * Owner: mobile. Pure TypeScript, no React Native imports (unit-tested in Node).
 *
 * Recognizes:  "2 melk", "melk 2", "500 g gehakt", "500g gehakt", "gehakt 500 g", "3x brood",
 *              "brood x3", "1,5 l melk", "2 liter melk", "1 pond gehakt" (= 500 g), "2 ons kaas" (= 200 g),
 *              "33 cl cola" (= 330 ml).
 * Units on the wire are only stuk | g | kg | ml | l (src/contracts/domain.ts).
 */
import { LIMITS, type ParsedEntry, type Unit } from '@/src/contracts';

interface UnitAlias {
  unit: Unit;
  factor: number;
}

/** Spoken/written unit words -> wire unit + multiplication factor. Keys are lower case. */
const UNIT_ALIASES: Record<string, UnitAlias> = {
  stuk: { unit: 'stuk', factor: 1 },
  stuks: { unit: 'stuk', factor: 1 },
  st: { unit: 'stuk', factor: 1 },
  g: { unit: 'g', factor: 1 },
  gr: { unit: 'g', factor: 1 },
  gram: { unit: 'g', factor: 1 },
  kg: { unit: 'kg', factor: 1 },
  kilo: { unit: 'kg', factor: 1 },
  kilogram: { unit: 'kg', factor: 1 },
  ons: { unit: 'g', factor: 100 },
  pond: { unit: 'g', factor: 500 },
  ml: { unit: 'ml', factor: 1 },
  milliliter: { unit: 'ml', factor: 1 },
  cl: { unit: 'ml', factor: 10 },
  dl: { unit: 'ml', factor: 100 },
  l: { unit: 'l', factor: 1 },
  ltr: { unit: 'l', factor: 1 },
  liter: { unit: 'l', factor: 1 },
  liters: { unit: 'l', factor: 1 },
};

// Longest first so "liter" wins over "l" and "kg" over "g".
const UNIT_WORDS = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length);
const UNIT_RE = `(?:${UNIT_WORDS.join('|')})`;
const NUM_RE = '(\\d{1,5}(?:[.,]\\d{1,3})?)';
const TIMES_RE = '[x×*]';

// "2 melk", "500 g gehakt", "500g gehakt", "3x brood", "3 x brood", "1,5 l melk"
const LEADING = new RegExp(`^${NUM_RE}\\s*(?:(${TIMES_RE})\\s*|(${UNIT_RE})\\.?\\s+|\\s+)(.+)$`, 'i');
// "x3 brood"
const LEADING_TIMES = new RegExp(`^${TIMES_RE}\\s*${NUM_RE}\\s+(.+)$`, 'i');
// "melk 2", "gehakt 500 g", "melk 1,5l", "brood 3x", "brood x3"
const TRAILING = new RegExp(`^(.+?)\\s+(?:${TIMES_RE}\\s*)?${NUM_RE}\\s*(?:(${TIMES_RE})|(${UNIT_RE})\\.?)?$`, 'i');
// Field in the item detail: "2", "2x", "500 g", "500g", "1,5 l", "x2", "2 stuks"
const FIELD = new RegExp(`^(?:${TIMES_RE}\\s*)?${NUM_RE}\\s*(?:(${TIMES_RE})|(${UNIT_RE})\\.?)?$`, 'i');

function toNumber(raw: string): number {
  return Number(raw.replace(',', '.'));
}

function roundQ(q: number): number {
  return Math.round(q * 1000) / 1000;
}

function validQuantity(q: number): boolean {
  return Number.isFinite(q) && q > 0 && q <= LIMITS.quantityMax;
}

function resolve(rawNumber: string, unitWord: string | undefined): { quantity: number; unit: Unit } | null {
  const alias = unitWord ? UNIT_ALIASES[unitWord.toLowerCase()] : undefined;
  if (unitWord && !alias) return null;
  const quantity = roundQ(toNumber(rawNumber) * (alias?.factor ?? 1));
  if (!validQuantity(quantity)) return null;
  return { quantity, unit: alias?.unit ?? 'stuk' };
}

/** Collapses whitespace, trims, caps the length, and capitalises a lower-case first letter ("melk" -> "Melk"). */
export function cleanItemName(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim().slice(0, LIMITS.nameMaxLength).trim();
  if (!s) return s;
  const first = s.charAt(0);
  return first === first.toLocaleLowerCase('nl-NL') && first !== first.toLocaleUpperCase('nl-NL')
    ? first.toLocaleUpperCase('nl-NL') + s.slice(1)
    : s;
}

/**
 * Parses what the user typed into the quick-add bar. Returns null for empty input.
 * Text that is only a number ("2") or has no name left stays a plain name.
 */
export function parseEntry(input: string): ParsedEntry | null {
  const text = input.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const attempt = (rawNumber: string, unitWord: string | undefined, rawName: string): ParsedEntry | null => {
    const name = cleanItemName(rawName);
    if (!name || /^\d+([.,]\d+)?$/.test(name) || UNIT_ALIASES[name.toLowerCase()] || /^[x×*]$/i.test(name)) return null;
    const q = resolve(rawNumber, unitWord);
    if (!q) return null;
    return { name, quantity: q.quantity, unit: q.unit, explicitQuantity: true };
  };

  let m = LEADING.exec(text);
  if (m) {
    const r = attempt(m[1]!, m[3], m[4]!);
    if (r) return r;
  }
  m = LEADING_TIMES.exec(text);
  if (m) {
    const r = attempt(m[1]!, undefined, m[2]!);
    if (r) return r;
  }
  m = TRAILING.exec(text);
  if (m) {
    const r = attempt(m[2]!, m[4], m[1]!);
    if (r) return r;
  }
  return { name: cleanItemName(text), quantity: 1, unit: 'stuk', explicitQuantity: false };
}

/**
 * Parses the "Hoeveelheid" field of the item detail sheet (same grammar, without a name).
 * Empty = 1 stuk. Returns null when the text is not a valid quantity.
 */
export function parseQuantityField(input: string): { quantity: number; unit: Unit } | null {
  const text = input.replace(/\s+/g, ' ').trim();
  if (!text) return { quantity: 1, unit: 'stuk' };
  const m = FIELD.exec(text);
  if (!m) return null;
  return resolve(m[1]!, m[3]);
}

/** 2 -> "2", 1.5 -> "1,5", 0.25 -> "0,25" (Dutch decimal comma, at most 3 decimals). */
export function formatNumber(n: number): string {
  return String(roundQ(n)).replace('.', ',');
}

/**
 * Muted quantity text behind the item name: nothing for 1 stuk, "2" for 2 stuks, "500 g", "1,5 l".
 */
export function formatQuantity(quantity: number, unit: Unit): string {
  if (unit === 'stuk') return quantity === 1 ? '' : formatNumber(quantity);
  return `${formatNumber(quantity)} ${unit}`;
}

/** Value for the "Hoeveelheid" field: "1" for 1 stuk so the field is never confusingly empty. */
export function formatQuantityField(quantity: number, unit: Unit): string {
  return unit === 'stuk' ? formatNumber(quantity) : `${formatNumber(quantity)} ${unit}`;
}

/** Snackbar after a merged add: "+1", "+500 g". */
export function formatIncrement(quantity: number, unit: Unit): string {
  return unit === 'stuk' ? `+${formatNumber(quantity)}` : `+${formatNumber(quantity)} ${unit}`;
}

/** Screen reader text for a quantity: "2", "500 gram", "1,5 liter"; empty for 1 stuk. */
export function speakQuantity(quantity: number, unit: Unit): string {
  const n = formatNumber(quantity);
  switch (unit) {
    case 'stuk':
      return quantity === 1 ? '' : n;
    case 'g':
      return `${n} gram`;
    case 'kg':
      return `${n} kilo`;
    case 'ml':
      return `${n} milliliter`;
    case 'l':
      return `${n} liter`;
  }
}
