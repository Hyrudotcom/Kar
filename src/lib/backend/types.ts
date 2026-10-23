/**
 * The app's view of the outside world. The screens only talk to a `Backend`; there are two
 * implementations: Supabase (device builds) and an in-memory demo (web preview, component tests).
 * Owner: mobile. Wire types come from src/contracts.
 */
import type {
  AcceptInviteResult,
  Connectivity,
  CreateHouseholdResult,
  CreateInviteResult,
  DeleteAccountResult,
  GetMyHouseholdResult,
  HouseholdErrorCode,
  LeaveHouseholdResult,
  PreviewInviteResult,
  PriceDataset,
  RemoveMemberResult,
  RenameHouseholdResult,
  SyncEngine,
  Uuid,
} from '@/src/contracts';

export interface AuthUser {
  id: Uuid;
  email: string | null;
  displayName: string;
}

export type AuthErrorCode = 'network' | 'invalid_code' | 'invalid_email' | 'rate_limited' | 'cancelled' | 'unavailable' | 'unknown';
export type AuthResult = { ok: true } | { ok: false; error: AuthErrorCode };

export interface AuthApi {
  /** Restores a persisted session (SecureStore). null when signed out. */
  getUser(): Promise<AuthUser | null>;
  /** Fires on sign-in, sign-out and session expiry (null). Duplicate events for the same user are possible. */
  onUserChange(listener: (user: AuthUser | null) => void): () => void;
  /** E-mail sign-in, 6-digit code only (no magic link). */
  sendEmailCode(email: string): Promise<AuthResult>;
  verifyEmailCode(email: string, code: string): Promise<AuthResult>;
  /** Apple / Google native sign-in result, exchanged for a Supabase session. */
  signInWithIdToken(provider: 'apple' | 'google', idToken: string, nonce?: string, fullName?: string | null): Promise<AuthResult>;
  /** Ends the session on this device. Local data is wiped separately by the session layer. */
  signOut(): Promise<void>;
}

/**
 * Household RPC results, plus 'network' when the call never reached the server and 'server' when the
 * server answered with an error (exception, 5xx, malformed body). Only 'network' means "Geen internet".
 */
export type Call<R> = Promise<R | { ok: false; error: 'network' | 'server' }>;
export type HouseholdCallError = HouseholdErrorCode | 'network' | 'server';

export interface HouseholdApi {
  getMyHousehold(): Call<GetMyHouseholdResult>;
  createHousehold(name?: string): Call<CreateHouseholdResult>;
  createInvite(householdId: Uuid, replace?: boolean): Call<CreateInviteResult>;
  previewInvite(code: string): Call<PreviewInviteResult>;
  acceptInvite(code: string): Call<AcceptInviteResult>;
  leaveHousehold(householdId: Uuid): Call<LeaveHouseholdResult>;
  removeMember(householdId: Uuid, userId: Uuid): Call<RemoveMemberResult>;
  renameHousehold(householdId: Uuid, name: string): Call<RenameHouseholdResult>;
  deleteAccount(): Call<DeleteAccountResult>;
}

export interface PriceApi {
  /** Reads the licensed price tables. Throws when the source is unreachable. */
  loadDataset(householdId: Uuid): Promise<PriceDataset>;
  /** profiles.price_comparison_enabled (per user, default false). */
  getOptIn(userId: Uuid): Promise<boolean>;
  setOptIn(userId: Uuid, enabled: boolean): Promise<void>;
  /** "Verkeerd product" (household-wide, per catalog item per chain) and "Toch gebruiken". */
  addOverride(householdId: Uuid, catalogItemId: string, chainId: string): Promise<void>;
  removeOverride(householdId: Uuid, catalogItemId: string, chainId: string): Promise<void>;
}

/** The engine as the app uses it (the full contract since the integration pass). */
export type AppEngine = SyncEngine;

export interface LocalDataApi {
  /** Opens `gb-<userId>.db` and starts a sync engine for this household. */
  openEngine(user: AuthUser, householdId: Uuid): Promise<AppEngine>;
  /** Stops the engine and deletes the user's database file (list, outbox, history, price cache). */
  wipe(userId: Uuid, engine: AppEngine | null): Promise<void>;
  /** Unsent outbox entries in a user's file that is not open (different-account warning). */
  countUnsent(userId: Uuid): Promise<number>;
}

/** Small values in SecureStore (pending_invite_code, last_user_id, cached household). */
export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface SignInProviders {
  /** Apple sign-in is offered on iOS only. */
  apple: boolean;
  /** Google client ids are configured (Supabase auth.external.google). */
  google: boolean;
}

export interface Backend {
  mode: 'supabase' | 'demo';
  auth: AuthApi;
  households: HouseholdApi;
  prices: PriceApi;
  local: LocalDataApi;
  connectivity: Connectivity;
  kv: KeyValueStore;
  providers: SignInProviders;
}

export const KV_KEYS = {
  pendingInviteCode: 'pending_invite_code',
  lastUserId: 'last_user_id',
  /** + `_<userId>`: last known household (id, name, role) for an offline cold start. */
  householdCache: 'household_cache',
  /** JSON array of user ids whose local file could not be deleted yet; retried at every start. */
  pendingWipes: 'pending_wipes',
} as const;
