/**
 * listFingerprint (architecture 6.2 rule 8, design-spec 4.5 rule 9): a stable hash of the compared
 * list, used to tell whether a cached comparison still matches the list ("Je lijst is gewijzigd sinds 10:42").
 * Order independent, survives restarts, pure JS (no crypto module; works in React Native).
 */
import type { BasketRequestItem, ListFingerprint } from '@/src/contracts';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit over the UTF-8 bytes of `s`, as 16 hex chars. */
export function fnv1a64(s: string): string {
  let h = FNV_OFFSET;
  const bytes = utf8(s);
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]!);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      c = Math.min(c, 0x10ffff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return out;
}

/** Quantity canonicalised to 3 decimals, so 1.5 and 1.5000000001 fingerprint the same. */
function canonicalQuantity(q: number): string {
  return Number.isFinite(q) ? (Math.round(q * 1000) / 1000).toString() : 'NaN';
}

export const listFingerprint: ListFingerprint = (items) => {
  const tuples = items
    .map((i) => [i.list_item_id, i.normalized_name, canonicalQuantity(i.quantity), i.unit, i.excluded ? 1 : 0] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return `v1:${tuples.length}:${fnv1a64(JSON.stringify(tuples))}`;
};

export function fingerprintMatches(items: BasketRequestItem[], fingerprint: string | null | undefined): boolean {
  return typeof fingerprint === 'string' && listFingerprint(items) === fingerprint;
}
