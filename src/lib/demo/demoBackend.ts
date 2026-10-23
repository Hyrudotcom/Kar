/**
 * In-memory backend for the web preview and component tests: no network, no SQLite, no prices.
 * Households follow the RPC contract of docs/architecture.md 4.3 closely enough to exercise every
 * screen (roles, invite codes, leave, remove, rename, delete account). List items live in the sync
 * builder's FakeServer, which implements the apply_mutations / pull_changes semantics.
 */
import {
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  INVITE_URL_BASE,
  LIMITS,
  type Connectivity,
  type HouseholdMember,
  type HouseholdRow,
  type Mutation,
  type PriceDataset,
  type PriceMatchOverride,
  type Unit,
  type Uuid,
} from '@/src/contracts';
import { emptyDataset } from '@/src/price/repository';
import { FakeServer } from '@/src/sync/testing/fakeServer';
import { ManualConnectivity } from '@/src/sync/util';

import { createMemoryKeyValue } from '../secureStorage';
import type { AppEngine, AuthApi, AuthUser, Backend, HouseholdApi, KeyValueStore, LocalDataApi, PriceApi } from '../backend/types';
import { DirectEngine } from './directEngine';

interface Membership {
  householdId: Uuid;
  role: 'owner' | 'member';
  joinedAt: string;
}

interface Invite {
  code: string;
  householdId: Uuid;
  createdBy: Uuid;
  expiresAt: number;
  revoked: boolean;
}

let counter = 0;
function demoUuid(): Uuid {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  counter++;
  const hex = (Date.now().toString(16) + counter.toString(16).padStart(8, '0')).slice(-12).padStart(12, '0');
  return `${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}-0000-4000-8000-${hex}`;
}

/** Shared demo state: users, memberships, invites, list items (FakeServer). */
export class DemoWorld {
  readonly server = new FakeServer({ uuid: demoUuid });
  readonly users = new Map<Uuid, AuthUser>();
  readonly memberships = new Map<Uuid, Membership>();
  readonly invites: Invite[] = [];
  readonly optIn = new Map<Uuid, boolean>();
  overrides: PriceMatchOverride[] = [];
  currentUser: AuthUser | null = null;
  now: () => number = () => Date.now();

  userByEmail(email: string): AuthUser {
    const e = email.trim().toLowerCase();
    for (const u of this.users.values()) if (u.email === e) return u;
    const u: AuthUser = { id: demoUuid(), email: e, displayName: e.split('@')[0] ?? '' };
    this.users.set(u.id, u);
    return u;
  }

  addUser(displayName: string, email: string | null = null): AuthUser {
    const u: AuthUser = { id: demoUuid(), email, displayName };
    this.users.set(u.id, u);
    return u;
  }

  householdRow(id: Uuid): HouseholdRow | null {
    const h = this.server.households.get(id);
    return h ? { id: h.id, name: h.name, created_at: h.created_at, last_seq: h.last_seq } : null;
  }

  membersOf(householdId: Uuid): HouseholdMember[] {
    return [...this.memberships.entries()]
      .filter(([, m]) => m.householdId === householdId)
      .map(([userId, m]) => ({
        household_id: householdId,
        user_id: userId,
        role: m.role,
        joined_at: m.joinedAt,
        display_name: this.users.get(userId)?.displayName ?? '',
      }))
      .sort((a, b) => a.joined_at.localeCompare(b.joined_at) || (a.user_id < b.user_id ? -1 : 1));
  }

  private lastJoin = 0;

  join(userId: Uuid, householdId: Uuid, role: 'owner' | 'member') {
    // Strictly increasing join times keep "longest-standing member" deterministic.
    this.lastJoin = Math.max(this.lastJoin + 1, this.now());
    this.memberships.set(userId, { householdId, role, joinedAt: new Date(this.lastJoin).toISOString() });
    const h = this.server.households.get(householdId);
    if (h && !h.members.has(userId)) this.server.addMember(householdId, userId);
  }

  /** Leave with automatic ownership transfer; returns whether the household is now empty. */
  leave(userId: Uuid): { householdId: Uuid; deleted: boolean; newOwner: Uuid | null } | null {
    const m = this.memberships.get(userId);
    if (!m) return null;
    this.memberships.delete(userId);
    this.server.removeMember(m.householdId, userId);
    const rest = this.membersOf(m.householdId);
    let newOwner: Uuid | null = null;
    if (m.role === 'owner' && rest.length > 0) {
      newOwner = rest[0]!.user_id;
      this.memberships.set(newOwner, { ...this.memberships.get(newOwner)!, role: 'owner' });
    }
    if (rest.length === 0) this.revokeInvites(m.householdId);
    return { householdId: m.householdId, deleted: rest.length === 0, newOwner };
  }

  revokeInvites(householdId: Uuid): boolean {
    let any = false;
    for (const i of this.invites) {
      if (i.householdId === householdId && !i.revoked) {
        i.revoked = true;
        any = true;
      }
    }
    return any;
  }

  newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < INVITE_CODE_LENGTH; i++) code += INVITE_CODE_ALPHABET[Math.floor(Math.random() * INVITE_CODE_ALPHABET.length)];
      if (!this.invites.some((i) => i.code === code)) return code;
    }
  }

  /** Another member adds items (as if typed on their phone). */
  addItemsAs(userId: Uuid, householdId: Uuid, items: { name: string; quantity?: number; unit?: Unit; note?: string; checked?: boolean }[]) {
    for (const it of items) {
      const id = demoUuid();
      const mutations: Mutation[] = [
        {
          id: demoUuid(),
          household_id: householdId,
          kind: 'add_item',
          payload: { id, name: it.name, quantity: it.quantity ?? 1, unit: it.unit ?? 'stuk', note: it.note ?? '' },
          client_created_at: new Date(this.now()).toISOString(),
        },
      ];
      if (it.checked) {
        mutations.push({ id: demoUuid(), household_id: householdId, kind: 'set_checked', payload: { item_id: id, checked: true }, client_created_at: new Date(this.now()).toISOString() });
      }
      this.server.applyMutations(userId, { household_id: householdId, mutations });
    }
  }
}

export interface DemoBackendOptions {
  world?: DemoWorld;
  /** Seed a housemate "Sanne" and the sample list from design-spec 4.3 into new households. */
  seed?: boolean;
  /** Follow the browser's online/offline events (web preview). */
  browserConnectivity?: boolean;
  connectivity?: ManualConnectivity;
  kv?: KeyValueStore;
  /** Price data for the route tab. Default: Open Prices, not verified for consumer display (v1). */
  priceDataset?: PriceDataset;
  /** Make loadDataset fail ("Prijzen tijdelijk niet beschikbaar"). */
  priceError?: boolean;
  /** Replace the DirectEngine, e.g. by the real sync engine over the same FakeServer in tests. */
  engineFactory?: (user: AuthUser, householdId: Uuid, world: DemoWorld) => Promise<AppEngine>;
  providers?: Backend['providers'];
}

export type DemoBackend = Backend & { world: DemoWorld; connectivity: ManualConnectivity };

export const OPEN_PRICES_UNVERIFIED: PriceDataset = emptyDataset([
  {
    id: 'open_prices',
    name: 'Open Prices',
    licence: 'ODbL-1.0',
    licence_url: 'https://opendatacommons.org/licenses/odbl/1-0/',
    attribution: 'Open Food Facts contributors',
    channel: 'national',
    verified_for_consumer_display: false,
  },
]);

export function createDemoBackend(opts: DemoBackendOptions = {}): DemoBackend {
  const world = opts.world ?? new DemoWorld();
  const connectivity = opts.connectivity ?? new ManualConnectivity(true);
  if (opts.browserConnectivity && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
    if (nav && nav.onLine === false) connectivity.set(false);
    window.addEventListener('online', () => connectivity.set(true));
    window.addEventListener('offline', () => connectivity.set(false));
  }
  const offline = () => !connectivity.isOnline();
  const listeners = new Set<(u: AuthUser | null) => void>();
  const setUser = (u: AuthUser | null) => {
    world.currentUser = u;
    for (const l of [...listeners]) l(u);
  };
  const me = () => world.currentUser;

  const auth: AuthApi = {
    getUser: async () => me(),
    onUserChange(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    async sendEmailCode(email) {
      if (offline()) return { ok: false, error: 'network' };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return { ok: false, error: 'invalid_email' };
      return { ok: true };
    },
    async verifyEmailCode(email, code) {
      if (offline()) return { ok: false, error: 'network' };
      if (!/^\d{6}$/.test(code) || code === '000000') return { ok: false, error: 'invalid_code' };
      setUser(world.userByEmail(email));
      return { ok: true };
    },
    async signInWithIdToken(provider) {
      if (offline()) return { ok: false, error: 'network' };
      const u = world.userByEmail(`demo-${provider}@voorbeeld.nl`);
      setUser(u);
      return { ok: true };
    },
    async signOut() {
      setUser(null);
    },
  };

  const online = <T>(fn: () => T): Promise<T | { ok: false; error: 'network' }> =>
    Promise.resolve(offline() ? { ok: false as const, error: 'network' as const } : fn());

  const households: HouseholdApi = {
    getMyHousehold: () =>
      online(() => {
        const u = me();
        if (!u) return { ok: false as const, error: 'not_authenticated' as const };
        const m = world.memberships.get(u.id);
        if (!m) return { ok: true as const, household: null, role: null, members: [] };
        return { ok: true as const, household: world.householdRow(m.householdId), role: m.role, members: world.membersOf(m.householdId) };
      }),
    createHousehold: (name = 'Thuis') =>
      online(() => {
        const u = me();
        if (!u) return { ok: false as const, error: 'not_authenticated' as const };
        const m = world.memberships.get(u.id);
        if (m) return { ok: true as const, household: world.householdRow(m.householdId)!, created: false };
        const id = world.server.createHousehold(u.id, name);
        world.join(u.id, id, 'owner');
        if (opts.seed) seedHousehold(world, id);
        return { ok: true as const, household: world.householdRow(id)!, created: true };
      }),
    createInvite: (householdId, replace = false) =>
      online(() => {
        const u = me();
        if (!u) return { ok: false as const, error: 'not_authenticated' as const };
        const m = world.memberships.get(u.id);
        if (!m || m.householdId !== householdId) return { ok: false as const, error: 'not_member' as const };
        if (replace && m.role !== 'owner') return { ok: false as const, error: 'not_owner' as const };
        const active = world.invites.find((i) => i.householdId === householdId && !i.revoked && i.expiresAt > world.now());
        if (active && !replace) return { ok: true as const, code: active.code, expires_at: new Date(active.expiresAt).toISOString(), url: INVITE_URL_BASE + active.code };
        world.revokeInvites(householdId);
        const inv: Invite = { code: world.newCode(), householdId, createdBy: u.id, expiresAt: world.now() + LIMITS.inviteValidityDays * 86_400_000, revoked: false };
        world.invites.push(inv);
        return { ok: true as const, code: inv.code, expires_at: new Date(inv.expiresAt).toISOString(), url: INVITE_URL_BASE + inv.code };
      }),
    previewInvite: (code) => online(() => preview(code)),
    acceptInvite: (code) =>
      online(() => {
        const p = preview(code);
        if (!p.ok) return p;
        const u = me()!;
        const current = world.memberships.get(u.id);
        let moved = 0;
        let left: Uuid | null = null;
        let deleted: Uuid | null = null;
        if (current) {
          const alone = world.membersOf(current.householdId).length === 1;
          const openItems = alone ? world.server.list(current.householdId).filter((i) => !i.checked) : [];
          world.leave(u.id);
          world.join(u.id, p.household_id, 'member');
          if (alone) {
            world.addItemsAs(u.id, p.household_id, openItems.map((i) => ({ name: i.name, quantity: i.quantity, unit: i.unit, note: i.note })));
            moved = openItems.length;
            deleted = current.householdId;
          } else {
            left = current.householdId;
          }
        } else {
          world.join(u.id, p.household_id, 'member');
        }
        return { ok: true as const, household_id: p.household_id, moved_items: moved, left_household_id: left, deleted_household_id: deleted };
      }),
    leaveHousehold: (householdId) =>
      online(() => {
        const u = me();
        if (!u) return { ok: false as const, error: 'not_authenticated' as const };
        if (world.memberships.get(u.id)?.householdId !== householdId) return { ok: false as const, error: 'not_member' as const };
        const r = world.leave(u.id)!;
        return { ok: true as const, household_deleted: r.deleted, new_owner_id: r.newOwner };
      }),
    removeMember: (householdId, userId) =>
      online(() => {
        const u = me();
        if (!u) return { ok: false as const, error: 'not_authenticated' as const };
        const m = world.memberships.get(u.id);
        if (!m || m.householdId !== householdId) return { ok: false as const, error: 'not_member' as const };
        if (m.role !== 'owner') return { ok: false as const, error: 'not_owner' as const };
        if (userId === u.id) return { ok: false as const, error: 'cannot_remove_self' as const };
        if (world.memberships.get(userId)?.householdId !== householdId) return { ok: false as const, error: 'not_member' as const };
        world.leave(userId);
        const revoked = world.revokeInvites(householdId);
        return { ok: true as const, invite_revoked: revoked };
      }),
    renameHousehold: (householdId, name) =>
      online(() => {
        const u = me();
        if (!u) return { ok: false as const, error: 'not_authenticated' as const };
        const m = world.memberships.get(u.id);
        if (!m || m.householdId !== householdId) return { ok: false as const, error: 'not_member' as const };
        if (m.role !== 'owner') return { ok: false as const, error: 'not_owner' as const };
        const n = name.trim();
        if (n.length < 1 || n.length > LIMITS.householdNameMaxLength) return { ok: false as const, error: 'invalid' as const };
        world.server.rename(householdId, n);
        return { ok: true as const, household: world.householdRow(householdId)! };
      }),
    deleteAccount: () =>
      online(() => {
        const u = me();
        if (!u) return { ok: false as const, error: 'not_authenticated' as const };
        const r = world.leave(u.id);
        world.users.delete(u.id);
        return { ok: true as const, household_deleted: r?.deleted ?? false };
      }),
  };

  function preview(rawCode: string) {
    const u = me();
    if (!u) return { ok: false as const, error: 'not_authenticated' as const };
    const code = rawCode.trim().toUpperCase();
    const inv = world.invites.find((i) => i.code === code);
    if (!inv) return { ok: false as const, error: 'invalid_code' as const };
    if (inv.revoked || inv.expiresAt <= world.now()) return { ok: false as const, error: 'expired_code' as const };
    const current = world.memberships.get(u.id);
    if (current?.householdId === inv.householdId) return { ok: false as const, error: 'already_member' as const };
    const currentOthers = current ? world.membersOf(current.householdId).length > 1 : false;
    return {
      ok: true as const,
      household_id: inv.householdId,
      household_name: world.householdRow(inv.householdId)?.name ?? 'Thuis',
      inviter_name: world.users.get(inv.createdBy)?.displayName ?? '',
      member_count: world.membersOf(inv.householdId).length,
      leaves_current_household: currentOthers,
      current_household_name: current ? (world.householdRow(current.householdId)?.name ?? null) : null,
    };
  }

  const prices: PriceApi = {
    async loadDataset(householdId) {
      if (offline() || opts.priceError) throw new Error('price source unreachable');
      const data = opts.priceDataset ?? OPEN_PRICES_UNVERIFIED;
      return { ...data, overrides: [...data.overrides, ...world.overrides.filter((o) => o.household_id === householdId)] };
    },
    getOptIn: async (userId) => world.optIn.get(userId) === true,
    setOptIn: async (userId, enabled) => {
      world.optIn.set(userId, enabled);
    },
    addOverride: async (householdId, catalogItemId, chainId) => {
      world.overrides.push({ household_id: householdId, catalog_item_id: catalogItemId, chain_id: chainId, created_by: me()?.id ?? null, created_at: new Date(world.now()).toISOString() });
    },
    removeOverride: async (householdId, catalogItemId, chainId) => {
      world.overrides = world.overrides.filter((o) => !(o.household_id === householdId && o.catalog_item_id === catalogItemId && o.chain_id === chainId));
    },
  };

  const local: LocalDataApi = {
    async openEngine(user, householdId) {
      if (opts.engineFactory) return opts.engineFactory(user, householdId, world);
      const engine = new DirectEngine(world.server, user.id, householdId, connectivity, demoUuid);
      await engine.start();
      return engine;
    },
    async wipe(_userId, engine) {
      if (engine) await (engine.dispose ? engine.dispose() : engine.stop());
    },
    countUnsent: async () => 0,
  };

  return {
    mode: 'demo',
    world,
    auth,
    households,
    prices,
    local,
    connectivity: connectivity as ManualConnectivity & Connectivity,
    kv: opts.kv ?? createMemoryKeyValue(),
    providers: opts.providers ?? { apple: true, google: true },
  };
}

/** Sample list from design-spec 4.3, added by housemate "Sanne". */
function seedHousehold(world: DemoWorld, householdId: Uuid) {
  const sanne = world.addUser('Sanne', 'sanne@voorbeeld.nl');
  world.join(sanne.id, householdId, 'member');
  world.addItemsAs(sanne.id, householdId, [
    { name: 'Koffiebonen', checked: true },
    { name: 'Appels', quantity: 6, checked: true },
    { name: 'Pindakaas', checked: true },
    { name: 'Brood' },
    { name: 'Gehakt', quantity: 500, unit: 'g' },
    { name: 'Bananen', quantity: 6 },
    { name: 'Melk', quantity: 2, note: 'halfvol' },
  ]);
}
