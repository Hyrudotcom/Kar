import { LIMITS, UNITS, type Unit } from '@/src/contracts';

/** Thrown synchronously-ish (rejected promise) by engine commands for input the server would reject. */
export class SyncInputError extends Error {
  constructor(
    readonly field: 'name' | 'note' | 'quantity' | 'unit' | 'delta' | 'item',
    message: string,
  ) {
    super(message);
    this.name = 'SyncInputError';
  }
}

/** numeric(12,3) rounding, avoiding float drift such as 0.1 + 0.2. */
export function roundQuantity(q: number): number {
  return Math.round(q * 1000) / 1000;
}

export function isValidQuantity(q: number): boolean {
  return Number.isFinite(q) && q > 0 && q <= LIMITS.quantityMax;
}

export function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > LIMITS.nameMaxLength) {
    throw new SyncInputError('name', `name must be 1..${LIMITS.nameMaxLength} characters`);
  }
  return trimmed;
}

export function cleanNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  if (note.length > LIMITS.noteMaxLength) {
    throw new SyncInputError('note', `note must be at most ${LIMITS.noteMaxLength} characters`);
  }
  return note;
}

export function cleanQuantity(q: number): number {
  const r = roundQuantity(q);
  if (!isValidQuantity(r)) throw new SyncInputError('quantity', `quantity must be > 0 and <= ${LIMITS.quantityMax}`);
  return r;
}

export function cleanDelta(d: number): number {
  const r = roundQuantity(d);
  if (!Number.isFinite(r) || r === 0) throw new SyncInputError('delta', 'delta must be a non-zero number');
  return r;
}

export function cleanUnit(u: string): Unit {
  if (!(UNITS as readonly string[]).includes(u)) throw new SyncInputError('unit', `unknown unit ${u}`);
  return u as Unit;
}
