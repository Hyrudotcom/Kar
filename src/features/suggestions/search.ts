/**
 * Local suggestion search (design-spec 3, SuggestionList): prefix and word-start matching,
 * diacritic-insensitive, sources in this order: checked items, household history (by frequency),
 * NL base catalog. Target < 16 ms per keystroke; in practice well under 1 ms (precomputed keys).
 */
import type { HistoryEntry, Unit, VisibleItem } from '@/src/contracts';
import { normalizeName } from '@/src/shared/normalize';

import { CATALOG } from './catalog';

export type SuggestionSource = 'checked' | 'history' | 'catalog';

export interface Suggestion {
  key: string;
  name: string;
  normalized: string;
  source: SuggestionSource;
  /** For checked items: the row it would restore (quantity/unit to reuse when none was typed). */
  item?: VisibleItem;
  unit?: Unit;
}

interface Entry {
  name: string;
  norm: string;
  /** norm with hyphens/slashes as spaces, prefixed by a space, for word-start matching. */
  words: string;
}

function toEntry(name: string): Entry {
  const norm = normalizeName(name);
  return { name, norm, words: ` ${norm.replace(/[-/(),.]+/g, ' ')}` };
}

/** 0 = whole-name prefix, 1 = word-start match, -1 = no match. */
function rank(e: Entry, q: string): number {
  if (e.norm.startsWith(q)) return 0;
  if (e.words.includes(` ${q}`)) return 1;
  return -1;
}

export class SuggestionIndex {
  private readonly catalog: Entry[];

  constructor(catalog: readonly string[] = CATALOG) {
    this.catalog = catalog.map(toEntry);
  }

  get size(): number {
    return this.catalog.length;
  }

  /**
   * Up to `limit` suggestions for the typed name (quantity already parsed off). The typed text
   * itself is never repeated: the "+ ‘…’ toevoegen" row above the list covers it.
   */
  suggest(query: string, ctx: { checked?: readonly VisibleItem[]; history?: readonly HistoryEntry[] }, limit = 3): Suggestion[] {
    const q = normalizeName(query);
    if (!q) return [];
    const seen = new Set<string>([q]);
    const out: Suggestion[] = [];

    const take = (cands: { entry: Entry; s: Omit<Suggestion, 'name' | 'normalized'> }[]) => {
      const ranked = cands
        .map((c, i) => ({ ...c, r: rank(c.entry, q), i }))
        .filter((c) => c.r >= 0)
        .sort((a, b) => a.r - b.r || a.i - b.i);
      for (const c of ranked) {
        if (out.length >= limit) return;
        if (seen.has(c.entry.norm)) continue;
        seen.add(c.entry.norm);
        out.push({ ...c.s, name: c.entry.name, normalized: c.entry.norm });
      }
    };

    take((ctx.checked ?? []).map((item) => ({ entry: toEntry(item.name), s: { key: `c:${item.id}`, source: 'checked' as const, item, unit: item.unit } })));
    if (out.length < limit) {
      take(
        [...(ctx.history ?? [])].sort((x, y) => y.use_count - x.use_count || y.last_used_at - x.last_used_at).map((h) => ({
          entry: { ...toEntry(h.display_name), norm: h.normalized_name },
          s: { key: `h:${h.normalized_name}|${h.unit}`, source: 'history' as const, unit: h.unit },
        })),
      );
    }
    if (out.length < limit) {
      // Catalog: rank 0 matches first, shorter names first within a rank (more generic).
      const matches: { e: Entry; r: number }[] = [];
      for (const e of this.catalog) {
        const r = rank(e, q);
        if (r >= 0) matches.push({ e, r });
      }
      matches.sort((a, b) => a.r - b.r || a.e.name.length - b.e.name.length || (a.e.name < b.e.name ? -1 : 1));
      for (const m of matches) {
        if (out.length >= limit) break;
        if (seen.has(m.e.norm)) continue;
        seen.add(m.e.norm);
        out.push({ key: `k:${m.e.norm}`, name: m.e.name, normalized: m.e.norm, source: 'catalog' });
      }
    }
    return out;
  }
}

let shared: SuggestionIndex | null = null;
/** Lazily built shared index over the bundled catalog. */
export function getSuggestionIndex(): SuggestionIndex {
  if (!shared) shared = new SuggestionIndex();
  return shared;
}
