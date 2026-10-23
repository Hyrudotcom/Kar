/**
 * "Niets beweegt onder je vinger" (design-spec 4.3, hard rule). Pure bookkeeping on top of the
 * engine's ListSnapshot:
 *  - a row whose checked state flips stays in its current section (struck through, or un-struck in
 *    Afgevinkt) until `settle()`; the screen calls settle 1.5 s after the last check and only when
 *    nobody is touching or scrolling;
 *  - new rows go straight to their section (new open rows at the top, by server position);
 *  - a checked row brought back by an add ("Melk teruggezet") gets a new top position and goes
 *    straight to the open section: only check taps linger, an add is visible at once;
 *  - deleted rows disappear; edits of visible rows update in place.
 */
import type { Uuid, VisibleItem } from '@/src/contracts';

export type Section = 'open' | 'checked';

export interface StableView {
  open: VisibleItem[];
  checked: VisibleItem[];
  /** Ids shown in a section they no longer belong to (waiting to settle). */
  lingering: Uuid[];
}

const byPositionDesc = (a: VisibleItem, b: VisibleItem) => b.position - a.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class StableOrder {
  private section = new Map<Uuid, Section>();
  private lastCheckedAt = new Map<Uuid, string>();
  private lastPosition = new Map<Uuid, number>();
  private items: VisibleItem[] = [];

  /** Feeds a new snapshot; returns the display lists. Idempotent for the same input. */
  compute(open: readonly VisibleItem[], checked: readonly VisibleItem[]): StableView {
    const all = [...open, ...checked];
    this.items = all;
    const present = new Set<Uuid>();
    for (const it of all) {
      present.add(it.id);
      const prevPos = this.lastPosition.get(it.id);
      // Only a restore by add moves a row to a higher position; an uncheck tap keeps it.
      if (!this.section.has(it.id) || (!it.checked && prevPos !== undefined && it.position > prevPos)) {
        this.section.set(it.id, it.checked ? 'checked' : 'open');
      }
      this.lastPosition.set(it.id, it.position);
      if (it.checked_at) this.lastCheckedAt.set(it.id, it.checked_at);
    }
    for (const id of [...this.section.keys()]) {
      if (!present.has(id)) {
        this.section.delete(id);
        this.lastCheckedAt.delete(id);
        this.lastPosition.delete(id);
      }
    }
    return this.view();
  }

  /** Moves every lingering row to its real section. Returns true when something moved. */
  settle(): boolean {
    let moved = false;
    for (const it of this.items) {
      const want: Section = it.checked ? 'checked' : 'open';
      if (this.section.get(it.id) !== want) {
        this.section.set(it.id, want);
        moved = true;
      }
    }
    return moved;
  }

  view(): StableView {
    const open: VisibleItem[] = [];
    const checked: VisibleItem[] = [];
    const lingering: Uuid[] = [];
    for (const it of this.items) {
      const s = this.section.get(it.id) ?? (it.checked ? 'checked' : 'open');
      (s === 'open' ? open : checked).push(it);
      if ((s === 'checked') !== it.checked) lingering.push(it.id);
    }
    open.sort(byPositionDesc);
    const at = (it: VisibleItem) => it.checked_at ?? this.lastCheckedAt.get(it.id) ?? '';
    checked.sort((a, b) => (at(b) < at(a) ? -1 : at(b) > at(a) ? 1 : a.id < b.id ? -1 : 1));
    return { open, checked, lingering: lingering.sort() };
  }
}
