import type { FailedMutation } from '@/src/contracts';

const KIND_NL: Record<FailedMutation['kind'], string> = {
  add_item: 'toevoegen',
  update_item: 'wijzigen',
  increment_quantity: 'hoeveelheid aanpassen',
  set_checked: 'afvinken',
  delete_item: 'verwijderen',
  restore_item: 'terugzetten',
  clear_checked: 'afgevinkte items wissen',
};

const REASON_NL: Record<FailedMutation['reason'], string> = {
  deleted: 'het item was al verwijderd',
  not_found: 'het item bestaat niet meer',
  invalid: 'ongeldige invoer',
  forbidden: 'niet toegestaan',
  not_member: 'je bent geen lid meer van dit huishouden',
};

/** Dutch summary line for the error sheet: "1 wijziging kon niet worden opgeslagen: Melk." */
export function failedSummary(failed: readonly FailedMutation[]): string {
  if (failed.length === 0) return '';
  const names = [...new Set(failed.map((f) => f.itemName).filter(Boolean))];
  const head = failed.length === 1 ? '1 wijziging kon niet worden opgeslagen' : `${failed.length} wijzigingen konden niet worden opgeslagen`;
  return names.length ? `${head}: ${names.join(', ')}.` : `${head}.`;
}

/** Plain text for "Kopieer als tekst". */
export function failedAsText(failed: readonly FailedMutation[]): string {
  if (failed.length === 0) return '';
  const lines = failed.map((f) => `- ${f.itemName || 'Onbekend item'}: ${KIND_NL[f.kind]} (${REASON_NL[f.reason]})`);
  return [failedSummary(failed), ...lines].join('\n');
}
