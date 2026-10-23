/** Dutch copy for household / invite / auth errors (design-spec 4.1, 4.2, 4.6). */
import type { AuthErrorCode, HouseholdCallError } from '@/src/lib/backend/types';

export const OFFLINE_ONLINE_ONLY = 'Geen internet. Inloggen en lid worden kan alleen online.';
export const SERVER_ERROR = 'Er ging iets mis. Probeer het opnieuw.';
/** "Deel lijst" offline: the login/join sentence does not fit there. */
export const OFFLINE_SHARE = 'Geen internet. Delen kan alleen online.';

export function householdErrorText(error: HouseholdCallError | 'pending' | 'offline', householdName = 'Thuis'): string {
  switch (error) {
    case 'network':
    case 'offline':
      return OFFLINE_ONLINE_ONLY;
    case 'invalid_code':
      return 'Deze code bestaat niet. Controleer de code en probeer het opnieuw.';
    case 'expired_code':
      return 'Deze code is verlopen. Een code is 7 dagen geldig. Vraag een nieuwe.';
    case 'already_member':
      return `Je bent al lid van ${householdName}.`;
    case 'rate_limited':
      return 'Te veel pogingen. Probeer het later opnieuw.';
    case 'not_owner':
      return 'Alleen de eigenaar kan dit doen.';
    case 'not_member':
      return `Je bent geen lid meer van ${householdName}.`;
    case 'cannot_remove_self':
      return 'Je kunt jezelf niet verwijderen. Kies "Huishouden verlaten".';
    case 'invalid':
      return 'Deze naam kan niet. Gebruik 1 tot 60 tekens.';
    case 'pending':
      return 'Je wijzigingen worden nog verstuurd. Probeer het zo opnieuw.';
    case 'server':
      return SERVER_ERROR;
    default:
      return 'Er ging iets mis. Probeer het opnieuw.';
  }
}

export function authErrorText(error: AuthErrorCode): string | null {
  switch (error) {
    case 'network':
      return OFFLINE_ONLINE_ONLY;
    case 'invalid_code':
      return 'Deze code klopt niet of is verlopen.';
    case 'invalid_email':
      return 'Vul een geldig e-mailadres in.';
    case 'rate_limited':
      return 'Te veel pogingen. Wacht even en probeer het opnieuw.';
    case 'cancelled':
      return null;
    case 'unavailable':
      return 'Deze manier van inloggen is nu niet beschikbaar.';
    default:
      return 'Inloggen lukte niet. Probeer het opnieuw.';
  }
}

/** "1 wijziging" / "4 wijzigingen". */
export function changesText(n: number): string {
  return n === 1 ? '1 wijziging' : `${n} wijzigingen`;
}
