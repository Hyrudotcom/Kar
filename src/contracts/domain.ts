/**
 * Core domain types shared by backend, sync, price and mobile.
 * Owner: architect. Change only via docs/architecture.md (section "Changing contracts").
 *
 * Wire format: all objects that cross the Supabase boundary use snake_case,
 * exactly matching the SQL column names in docs/architecture.md section 3.
 */

/** RFC 4122 uuid string, lower case. List item ids and mutation ids are generated on the client. */
export type Uuid = string;
/** ISO 8601 timestamp with timezone, as returned by PostgREST (server clock). */
export type IsoTimestamp = string;

/** The only units in v1 (design-spec 3, QuickAddBar). 'stuk' is the default. */
export const UNITS = ['stuk', 'g', 'kg', 'ml', 'l'] as const;
export type Unit = (typeof UNITS)[number];

export type HouseholdRole = 'owner' | 'member';

/** Limits enforced by SQL check constraints and validated on the client. */
export const LIMITS = {
  nameMaxLength: 120,
  noteMaxLength: 140,
  householdNameMaxLength: 60,
  displayNameMaxLength: 60,
  quantityMin: 0.001, // exclusive lower bound is 0; values must be > 0
  quantityMax: 99999,
  quantityDecimals: 3,
  mutationsPerBatch: 100,
  pullPageSize: 500,
  inviteValidityDays: 7,
} as const;

/** Invite code alphabet: no 0/O/1/I (design-spec 4.2). Codes are 6 characters. */
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const INVITE_CODE_LENGTH = 6;
export const INVITE_CODE_REGEX = /^[A-HJ-NP-Z2-9]{6}$/;
/** Share URL base; the HTTPS page opens the app or shows the code + store buttons. */
export const INVITE_URL_BASE = 'https://getkar.nl/j/';

/** A row of public.list_items as returned by pull_changes (snake_case wire format). */
export interface ListItemRow {
  id: Uuid;
  household_id: Uuid;
  name: string;
  /** Server-computed with public.gb_normalize_name(); see src/shared/normalize.ts. */
  normalized_name: string;
  /** Postgres numeric(12,3). PostgREST/RPC jsonb returns it as a JSON number. */
  quantity: number;
  unit: Unit;
  note: string;
  checked: boolean;
  checked_at: IsoTimestamp | null;
  /** Sort key for open items: higher = newer = higher on screen. Server assigned (= server_seq at add/restore). */
  position: number;
  /** "Niet vergelijken": excluded from price comparison for all stores (design-spec 4.5). */
  exclude_from_comparison: boolean;
  created_by: Uuid | null;
  created_at: IsoTimestamp;
  updated_by: Uuid | null;
  updated_at: IsoTimestamp;
  /** Tombstone. Non-null = deleted. Delete wins over edits; only restore_item clears it. */
  deleted_at: IsoTimestamp | null;
  deleted_by: Uuid | null;
  /** Per-household monotonically increasing sequence of the last change to this row. */
  server_seq: number;
}

export interface HouseholdRow {
  id: Uuid;
  name: string;
  created_at: IsoTimestamp;
  /** Highest server_seq handed out in this household. */
  last_seq: number;
}

export interface HouseholdMemberRow {
  household_id: Uuid;
  user_id: Uuid;
  role: HouseholdRole;
  joined_at: IsoTimestamp;
}

/** Member joined with profile, as returned by get_my_household(). */
export interface HouseholdMember extends HouseholdMemberRow {
  display_name: string;
}

export interface ProfileRow {
  user_id: Uuid;
  display_name: string;
  /** Per-user opt-in for "Goedkoopste route" content (design-spec 4.5 / 4.6). Default false. */
  price_comparison_enabled: boolean;
  created_at: IsoTimestamp;
}

export interface InviteRow {
  id: Uuid;
  household_id: Uuid;
  code: string;
  created_by: Uuid | null;
  created_at: IsoTimestamp;
  expires_at: IsoTimestamp;
  revoked_at: IsoTimestamp | null;
}

/**
 * Result of the quick-add / quantity parser (src/shared/quantity.ts, owner: mobile).
 * Recognizes "2 melk", "melk 2", "500 g gehakt", "3x brood", "1,5 l melk" (design-spec 3).
 */
export interface ParsedEntry {
  name: string;
  quantity: number;
  unit: Unit;
  /** false when the user typed no quantity (quantity defaults to 1 stuk). */
  explicitQuantity: boolean;
}
