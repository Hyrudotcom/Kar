/**
 * Household / invite RPC contract (all online-only). Owner: architect.
 * Each RPC is `security definer`, uses auth.uid(), and returns jsonb shaped like below.
 * Errors are returned as `{ ok: false, error }`, never as raw Postgres exceptions,
 * so the client can map them to Dutch copy (docs/architecture.md section 4.3).
 */
import type { HouseholdMember, HouseholdRow, IsoTimestamp, Uuid } from './domain';

export type HouseholdErrorCode =
  | 'not_authenticated'
  | 'not_member'
  | 'not_owner'
  | 'invalid_code' // unknown code
  | 'expired_code' // expired or revoked ("Deze code is verlopen...")
  | 'already_member' // "Je bent al lid van Thuis."
  | 'rate_limited'
  | 'cannot_remove_self'
  | 'invalid';

export type RpcResult<T> = ({ ok: true } & T) | { ok: false; error: HouseholdErrorCode };

/** get_my_household() -> the caller's household (v1: at most one), or household: null. */
export type GetMyHouseholdResult = RpcResult<{
  household: HouseholdRow | null;
  role: 'owner' | 'member' | null;
  members: HouseholdMember[];
  /**
   * Households of this user that accept_invite merged into this one (the user was alone there).
   * Another phone whose file still holds one of them follows along; any other household change is
   * a removal or leave for that phone. Optional: older servers do not send it.
   */
  merged_from?: Uuid[];
}>;

/** create_household(p_name text default 'Thuis'): idempotent "ensure". Returns existing if already a member. */
export type CreateHouseholdResult = RpcResult<{ household: HouseholdRow; created: boolean }>;

/**
 * create_invite(p_household_id uuid, p_replace boolean default false)
 * Reuses the single active code while valid (7 days); otherwise creates a new one.
 * p_replace = true ("Code vervangen") requires owner.
 */
export type CreateInviteResult = RpcResult<{ code: string; expires_at: IsoTimestamp; url: string }>;

/** preview_invite(p_code text): data for "Word je lid van ...?" Rate limited like accept. */
export type PreviewInviteResult = RpcResult<{
  household_id: Uuid;
  household_name: string;
  inviter_name: string;
  member_count: number;
  /** true if the caller's current household has other members -> show "Je verlaat dan Thuis." */
  leaves_current_household: boolean;
  current_household_name: string | null;
}>;

/**
 * accept_invite(p_code text)
 * - caller alone in current household: open items move along (deduped), old household deleted
 * - current household has others: caller leaves it (ownership transfer), items stay
 * Client must drain its outbox before calling (online-only flow).
 */
export type AcceptInviteResult = RpcResult<{
  household_id: Uuid;
  moved_items: number;
  left_household_id: Uuid | null;
  deleted_household_id: Uuid | null;
}>;

/** leave_household(p_household_id uuid). Last member -> household deleted. Client then calls create_household. */
export type LeaveHouseholdResult = RpcResult<{ household_deleted: boolean; new_owner_id: Uuid | null }>;

/** remove_member(p_household_id uuid, p_user_id uuid). Owner only. Always revokes the active invite. */
export type RemoveMemberResult = RpcResult<{ invite_revoked: boolean }>;

/** rename_household(p_household_id uuid, p_name text). Owner only. */
export type RenameHouseholdResult = RpcResult<{ household: HouseholdRow }>;

/** delete_account(): same ownership rules as leave, then deletes auth user + profile. */
export type DeleteAccountResult = RpcResult<{ household_deleted: boolean }>;

/** Names of the RPCs, for supabase.rpc(name, args). Args use the p_ prefixed names above. */
export const HOUSEHOLD_RPCS = {
  getMyHousehold: 'get_my_household',
  createHousehold: 'create_household',
  createInvite: 'create_invite',
  previewInvite: 'preview_invite',
  acceptInvite: 'accept_invite',
  leaveHousehold: 'leave_household',
  removeMember: 'remove_member',
  renameHousehold: 'rename_household',
  deleteAccount: 'delete_account',
} as const;

export const SYNC_RPCS = {
  applyMutations: 'apply_mutations',
  pullChanges: 'pull_changes',
} as const;
