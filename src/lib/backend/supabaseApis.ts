/**
 * Supabase-backed auth, household and price APIs. Free of React Native / Expo imports so the Node
 * integration tests (tests/integration) exercise exactly this code against the local stack.
 */
import type { SupabaseClient, User } from '@supabase/supabase-js';

import { HOUSEHOLD_RPCS } from '@/src/contracts';
import { loadPriceDataset } from '@/src/price/repository';

import type { AuthApi, AuthErrorCode, AuthResult, AuthUser, Call, HouseholdApi, PriceApi } from './types';

export function toAuthUser(u: User | null | undefined): AuthUser | null {
  if (!u) return null;
  const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
  const name = [meta.full_name, meta.name].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return { id: u.id, email: u.email ?? null, displayName: name ?? (u.email ? u.email.split('@')[0]! : '') };
}

function authError(e: unknown): AuthErrorCode {
  const err = e as { status?: number; name?: string; code?: string; message?: string } | null;
  if (!err) return 'unknown';
  if (err.name === 'AuthRetryableFetchError' || /network|fetch|timeout/i.test(err.message ?? '')) return 'network';
  if (err.status === 429 || err.code === 'over_email_send_rate_limit' || err.code === 'over_request_rate_limit') return 'rate_limited';
  if (err.code === 'otp_expired' || err.code === 'invalid_credentials' || err.status === 403 || err.status === 401) return 'invalid_code';
  if (err.code === 'email_address_invalid' || err.code === 'validation_failed') return 'invalid_email';
  return 'unknown';
}

export function createAuth(sb: SupabaseClient): AuthApi {
  const result = (error: unknown): AuthResult => (error ? { ok: false, error: authError(error) } : { ok: true });
  return {
    async getUser() {
      const { data } = await sb.auth.getSession();
      return toAuthUser(data.session?.user);
    },
    onUserChange(listener) {
      const { data } = sb.auth.onAuthStateChange((_event, session) => listener(toAuthUser(session?.user)));
      return () => data.subscription.unsubscribe();
    },
    async sendEmailCode(email) {
      try {
        const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
        return result(error);
      } catch (e) {
        return { ok: false, error: authError(e) };
      }
    },
    async verifyEmailCode(email, code) {
      try {
        const { error } = await sb.auth.verifyOtp({ email, token: code, type: 'email' });
        return result(error);
      } catch (e) {
        return { ok: false, error: authError(e) };
      }
    },
    async signInWithIdToken(provider, token, nonce, fullName) {
      try {
        const { error } = await sb.auth.signInWithIdToken({ provider, token, nonce });
        if (!error && fullName) {
          // Apple only sends the name on the very first sign-in.
          await sb.auth.updateUser({ data: { full_name: fullName } }).catch(() => undefined);
        }
        return result(error);
      } catch (e) {
        return { ok: false, error: authError(e) };
      }
    },
    async signOut() {
      try {
        await sb.auth.signOut({ scope: 'local' });
      } catch {
        /* offline: the local session is removed anyway */
      }
    },
  };
}

/** true when the request never got an HTTP answer (offline, DNS, reset, timeout). */
export function isTransportFailure(status: number | undefined, error: unknown): boolean {
  if (status !== undefined && status > 0) return false;
  const msg = String((error as { message?: unknown } | null)?.message ?? error ?? '');
  return status === 0 || /fetch|network|timeout|abort|ECONN|ENOTFOUND|EAI_AGAIN/i.test(msg);
}

export function createHouseholds(sb: SupabaseClient): HouseholdApi {
  async function call<R>(fn: string, args?: Record<string, unknown>): Call<R> {
    try {
      const { data, error, status } = await sb.rpc(fn, args);
      // postgrest-js reports a failed fetch (no connection, DNS, timeout) as status 0.
      if (error) return { ok: false, error: isTransportFailure(status, error) ? 'network' : 'server' };
      if (data === null || typeof data !== 'object') return { ok: false, error: 'server' };
      return data as R;
    } catch (e) {
      return { ok: false, error: isTransportFailure(0, e) ? 'network' : 'server' };
    }
  }
  return {
    getMyHousehold: () => call(HOUSEHOLD_RPCS.getMyHousehold),
    createHousehold: (name = 'Thuis') => call(HOUSEHOLD_RPCS.createHousehold, { p_name: name }),
    createInvite: (householdId, replace = false) => call(HOUSEHOLD_RPCS.createInvite, { p_household_id: householdId, p_replace: replace }),
    previewInvite: (code) => call(HOUSEHOLD_RPCS.previewInvite, { p_code: code }),
    acceptInvite: (code) => call(HOUSEHOLD_RPCS.acceptInvite, { p_code: code }),
    leaveHousehold: (householdId) => call(HOUSEHOLD_RPCS.leaveHousehold, { p_household_id: householdId }),
    removeMember: (householdId, userId) => call(HOUSEHOLD_RPCS.removeMember, { p_household_id: householdId, p_user_id: userId }),
    renameHousehold: (householdId, name) => call(HOUSEHOLD_RPCS.renameHousehold, { p_household_id: householdId, p_name: name }),
    deleteAccount: () => call(HOUSEHOLD_RPCS.deleteAccount),
  };
}

export function createPrices(sb: SupabaseClient): PriceApi {
  return {
    loadDataset: (householdId) => loadPriceDataset(sb, { householdId }),
    async getOptIn(userId) {
      const { data, error } = await sb.from('profiles').select('price_comparison_enabled').eq('user_id', userId).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as { price_comparison_enabled?: boolean } | null)?.price_comparison_enabled === true;
    },
    async setOptIn(userId, enabled) {
      const { error } = await sb.from('profiles').update({ price_comparison_enabled: enabled }).eq('user_id', userId);
      if (error) throw new Error(error.message);
    },
    async addOverride(householdId, catalogItemId, chainId) {
      const { error } = await sb
        .from('price_match_overrides')
        .upsert({ household_id: householdId, catalog_item_id: catalogItemId, chain_id: chainId }, { onConflict: 'household_id,catalog_item_id,chain_id', ignoreDuplicates: true });
      if (error) throw new Error(error.message);
    },
    async removeOverride(householdId, catalogItemId, chainId) {
      const { error } = await sb
        .from('price_match_overrides')
        .delete()
        .eq('household_id', householdId)
        .eq('catalog_item_id', catalogItemId)
        .eq('chain_id', chainId);
      if (error) throw new Error(error.message);
    },
  };
}
