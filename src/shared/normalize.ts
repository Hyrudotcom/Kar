/**
 * Item name normalization used for dedupe and suggestions.
 * MUST stay byte-identical to SQL public.gb_normalize_name(text):
 *
 *   btrim(regexp_replace(lower(regexp_replace(normalize(name, NFKD), '[̀-ͯ]', '', 'g')), '\s+', ' ', 'g'))
 *
 * Steps: NFKD -> strip combining marks U+0300..U+036F -> lower case -> collapse whitespace -> trim.
 * Shared test vectors: NORMALIZE_VECTORS (backend tests must assert the same pairs in SQL).
 * Owner: architect (sync builder may extend tests, not semantics).
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export const NORMALIZE_VECTORS: readonly (readonly [string, string])[] = [
  ['Melk', 'melk'],
  ['  Crème   Fraîche ', 'creme fraiche'],
  ['Ĳs', 'ijs'], // Dutch IJ ligature
  ['Müsli', 'musli'],
  ['PAPRIKA\trood', 'paprika rood'],
  ['Café au lait', 'cafe au lait'],
  ['Brood', 'brood'],
];
