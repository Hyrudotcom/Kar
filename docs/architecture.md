# Kar: architecture v1

Status: authoritative for engineering. UX is governed by `design-spec.md` (discovery folder); this
document governs data, sync, security and folder ownership. When the two disagree on UX, the design
spec wins; when they disagree on data or protocol, raise it with the architect before coding.

Stack: Expo SDK 58 (React Native 0.88, React 19.3, TypeScript 6, expo-router 58), Supabase
(Postgres 17, Auth, RLS, Realtime). Two tabs only: "Mijn lijst" and "Goedkoopste route". All UI copy is Dutch.

---

## 1. Folder ownership

Parallel builders only write inside their own folders. Anything else is a request to the owner.
**Nobody runs `npm install`**: every dependency is already in `package.json`. If something is
truly missing, ask the architect.

| Owner | Paths | Notes |
|---|---|---|
| **architect** | `docs/**`, `src/contracts/**`, `src/shared/normalize.ts`, root config (`package.json`, `app.json`, `tsconfig.json`, `jest.config.js`, `eslint.config.js`, `playwright.config.ts`, `.env.example`, `scripts/**`) | Contracts change only through the architect (section 9). |
| **backend** | `supabase/**` except the price files below: `config.toml`, `templates/`, `seed.sql`, `functions/`, `migrations/20261023000100_core.sql` … `20261023000400_realtime.sql`, `tests/*.test.ts` (not `tests/prices*`) | Owns schema, RLS, RPCs, auth config. |
| **sync** | `src/sync/**` | Local SQLite store, outbox, reducer, push/pull loop, realtime nudge, transports (Supabase + test fakes). |
| **price** | `src/price/**`, `supabase/migrations/20261023001000_prices.sql`, `supabase/tests/prices*.test.ts` | Pure comparison engine + price schema. No real price data exists; never seed fake prices outside test files. |
| **mobile** | `app/**`, `src/ui/**`, `src/features/**`, `src/lib/**`, `src/shared/quantity.ts`, `e2e/**`, `assets/**` | Screens, components, auth flows, Supabase client, quick-add parser, suggestions catalog. |

Rules for everyone:
- Import shared types from `@/src/contracts` (path alias `@/` = repo root).
- Never put test files in `app/` (expo-router treats every file there as a route). Screen tests go in `src/features/**/__tests__`.
- Supabase client is created once in `src/lib/supabase.ts` (mobile) and injected into the sync transport.
- No `localStorage`/AsyncStorage for user data. Secrets/session: `expo-secure-store`. Data: per-user SQLite.

### npm scripts

| Script | What |
|---|---|
| `npm run typecheck` | `tsc --noEmit` over the whole repo (excludes `supabase/functions`, Deno). |
| `npm run lint` | ESLint (eslint-config-expo flat). |
| `npm test` | Jest projects `app` (jest-expo, `src/ui`, `src/features`), `unit` (Node: `src/shared`, `src/price`, `src/contracts`), `sync` (Node: `src/sync`). No network, no DB. |
| `npm run test:sync` | Only the `sync` project (better-sqlite3 + fake/pg transport). |
| `npm run test:price` | Only the `unit` project. |
| `npm run test:db` | Jest project `db` (`supabase/tests/**`, `--runInBand`) against the local stack via `pg` at `SUPABASE_DB_URL` (default `postgresql://postgres:postgres@127.0.0.1:54322/postgres`). Requires `npm run db:start`. |
| `npm run export:web` | `expo export --platform web` into `dist/` (SPA, `web.output = single`). |
| `npm run serve:web` / `npm run test:e2e` | Static server on :8099 (with COOP/COEP headers for expo-sqlite web) / Playwright using the preinstalled Chromium at `/opt/pw-browsers/chromium-1243` (never run `playwright install`). |
| `npm run db:start` / `db:reset` / `db:stop` / `db:types` | Supabase CLI local stack; `db:types` writes `src/contracts/database.types.ts` (architect commits it). |

Environment notes: Docker CLI and `dockerd` are installed but the daemon is not running by default
(`dockerd > /tmp/dockerd.log 2>&1 &` before `npm run db:start`). `api.expo.dev` is blocked by the
egress proxy: prefix Expo CLI commands with `EXPO_OFFLINE=1`.

---

## 2. Identity, auth and local data

- **Sign-in** (design-spec 4.1): Apple (`expo-apple-authentication`, nonce via `expo-crypto` SHA-256,
  `supabase.auth.signInWithIdToken({ provider: 'apple', token, nonce })`), Google (`expo-auth-session`
  + `expo-web-browser` to obtain an ID token, then `signInWithIdToken({ provider: 'google' })`), and
  e-mail **6-digit OTP only** (`signInWithOtp({ email, options: { shouldCreateUser: true } })` then
  `verifyOtp({ email, token, type: 'email' })`). No magic links: the e-mail templates in
  `supabase/templates/otp.html` only contain `{{ .Token }}`. OTP expiry 600 s. iOS shows Apple first,
  Android shows Google first. Accounts are never merged by e-mail.
- **Session storage**: Supabase `auth.storage` = a chunked `expo-secure-store` adapter
  (SecureStore values are limited to ~2 KB; split into `sb-session.0..n`). `localStorage` on web.
- **After sign-in**: `create_household()` (idempotent ensure; silently creates "Thuis"), then
  `get_my_household()`, then open the per-user DB and start the sync engine. If a pending invite code
  is in SecureStore (`pending_invite_code`, saved when a `/j/<code>` link was opened before login), go
  straight to the "Word je lid van …?" sheet.
- **Per-user database**: `gb-<userId>.db` (expo-sqlite). SecureStore key `last_user_id` remembers whose
  file is on disk. If a different user signs in while an old file still has an outbox, the app warns
  explicitly and then deletes the old file (design-spec 5.10).
- **Wipe** (design-spec 5.9): logout, leave and removal call `engine.stop()` then
  `SqlDriverFactory.destroy(userId)`, which deletes the list, outbox, failed mutations, suggestion
  history and price cache. Logout with a non-empty outbox shows "Je hebt N wijzigingen die nog niet
  verstuurd zijn." [Toch uitloggen]. Leaving is disabled offline ("Verlaten kan alleen online").
- **Deep links**: `https://getkar.nl/j/<CODE>` (iOS associated domain, Android verified intent
  filter, configured in `app.json`) and `kar://j/<CODE>` both route to `app/j/[code].tsx`.
  Hosting the HTTPS fallback page (code + store buttons) is out of scope for this repo.

---

## 3. SQL schema (backend: `20261023000100_core.sql`)

Conventions: every function is `security definer` only when it must be, always with
`set search_path = ''` and fully qualified names. Internal tables live in schema `private`, which is
not exposed by PostgREST. Clients never write tables directly: **all writes go through RPCs**, so the
invariants (server_seq, dedupe, tombstones, idempotency) cannot be bypassed.

```sql
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;   -- only so RLS policies can call private.is_member

-- Name normalization. MUST equal src/shared/normalize.ts (NFKD, strip U+0300-036F, lower, collapse ws, trim).
-- Test vectors: NORMALIZE_VECTORS in src/shared/normalize.ts; backend asserts the same pairs in SQL.
create or replace function public.gb_normalize_name(p text) returns text
language sql immutable strict parallel safe set search_path = '' as $$
  select btrim(regexp_replace(lower(regexp_replace(normalize(p, NFKD), '[̀-ͯ]', '', 'g')), '\s+', ' ', 'g'))
$$;

create table public.profiles (
  user_id                  uuid primary key references auth.users(id) on delete cascade,
  display_name             text not null default '' check (char_length(display_name) <= 60),
  price_comparison_enabled boolean not null default false,       -- per-user opt-in (design-spec 4.5/4.6)
  created_at               timestamptz not null default now()
);
-- trigger on auth.users insert: display_name := coalesce(meta.full_name, meta.name, split_part(email,'@',1), '')

create table public.households (
  id                uuid primary key default gen_random_uuid(),
  name              text not null default 'Thuis' check (char_length(btrim(name)) between 1 and 60),
  created_at        timestamptz not null default now(),
  last_seq          bigint not null default 0,   -- highest server_seq handed out in this household
  purged_before_seq bigint not null default 0    -- tombstones with server_seq < this were purged
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('owner', 'member')),
  joined_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);
create unique index household_members_one_per_user on public.household_members(user_id);             -- v1: one household per user
create unique index household_members_one_owner    on public.household_members(household_id) where role = 'owner';

create table public.invites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  code         text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),   -- no 0/O/1/I; unique forever
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '7 days'),
  revoked_at   timestamptz
);
create unique index invites_one_unrevoked on public.invites(household_id) where revoked_at is null;

create table public.list_items (
  id                      uuid primary key,                               -- generated on the client (uuid v4)
  household_id            uuid not null references public.households(id) on delete cascade,
  name                    text not null check (char_length(btrim(name)) between 1 and 120),
  normalized_name         text generated always as (public.gb_normalize_name(name)) stored,
  quantity                numeric(12,3) not null default 1 check (quantity > 0 and quantity <= 99999),
  unit                    text not null default 'stuk' check (unit in ('stuk','g','kg','ml','l')),
  note                    text not null default '' check (char_length(note) <= 140),
  checked                 boolean not null default false,
  checked_at              timestamptz,
  position                bigint not null,           -- = server_seq at add/restore-from-checked; open items sort desc
  exclude_from_comparison boolean not null default false,  -- "Niet vergelijken"
  created_by              uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_by              uuid references auth.users(id) on delete set null,
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,               -- tombstone; delete wins
  deleted_by              uuid references auth.users(id) on delete set null,
  server_seq              bigint not null            -- per-household order of the last change to this row
);
create index list_items_pull   on public.list_items(household_id, server_seq);
create index list_items_dedupe on public.list_items(household_id, normalized_name, unit) where deleted_at is null;
-- Deliberately NO unique index on (normalized_name, unit): renames may create duplicates (design-spec F41).
-- Dedupe happens only in add_item, serialized by the household row lock.

-- Idempotency log, keyed by client mutation id. Retained 90 days.
create table private.mutations (
  id           uuid primary key,
  household_id uuid not null,
  user_id      uuid not null,
  kind         text not null,
  result       jsonb not null,           -- the MutationResult returned the first time
  received_at  timestamptz not null default now()
);
create index on private.mutations(received_at);

-- add_item that merged/restored into another row: later mutations that target the alias are redirected.
create table private.item_aliases (
  alias_id     uuid primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  target_id    uuid not null references public.list_items(id) on delete cascade,
  created_at   timestamptz not null default now()
);

create table private.invite_attempts (
  id           bigserial primary key,
  user_id      uuid,
  ip           text,                     -- from request.headers x-forwarded-for (first hop)
  code         text not null,
  household_id uuid,                     -- set when the code matched an (expired/revoked/valid) invite
  success      boolean not null,
  at           timestamptz not null default now()
);
create index on private.invite_attempts(at);

create function private.is_member(p_household uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.household_members m
                 where m.household_id = p_household and m.user_id = (select auth.uid()))
$$;
grant execute on function private.is_member(uuid) to authenticated;
```

### 3.1 RLS (strict separation between households)

RLS is enabled on every table in `public`. `anon` has no grants at all.

| Table | select | insert / update / delete |
|---|---|---|
| `profiles` | own row, or a co-member's row | update own row, columns `display_name`, `price_comparison_enabled` only (column grant). No insert/delete (trigger + `delete_account`). |
| `households` | `private.is_member(id)` | none (RPC only) |
| `household_members` | `private.is_member(household_id)` | none (RPC only) |
| `invites` | none: no client grant and no policy (clients get the code only from `create_invite`) | none (RPC only) |
| `list_items` | `private.is_member(household_id)` | none (`apply_mutations` only) |
| price reference tables | `authenticated` | none (service role ingestion) |
| `price_match_overrides` | `private.is_member(household_id)` | insert/delete if `private.is_member(household_id)` |

`revoke insert, update, delete on public.households, public.household_members, public.invites, public.list_items from anon, authenticated;`
`test:db` must prove for two households A and B: a member of A cannot select, pull, mutate, alias,
invite into or realtime-subscribe to anything of B, including by guessing ids (an `add_item` with an
id that exists in B returns `rejected/invalid` and leaks nothing).

### 3.2 Realtime (`20261023000400_realtime.sql`)

- `alter publication supabase_realtime add table public.list_items, public.households, public.household_members;`
  Postgres-changes are RLS-filtered, so only members receive them. Clients treat every event as a
  **nudge** to pull; payloads are never applied as data.
- Membership loss: a trigger on `household_members` delete calls
  `realtime.send(jsonb_build_object('household_id', old.household_id, 'reason', <reason>), 'membership_changed', 'user:' || old.user_id, true)`
  (private broadcast channel; `MembershipChangedBroadcast` in `src/contracts/mutations.ts`). `reason` is
  `removed`, `left`, `household_deleted` or `account_deleted`. After `accept_invite` the joiner also gets
  `household_deleted` for its old solo household, so clients ignore broadcasts whose `household_id` is not
  the current household. RLS on `realtime.messages` allows `select` when
  `realtime.topic() = 'user:' || auth.uid()`. Fallback (always on): membership is checked on every app
  open/foreground, and every `pull_changes`/`apply_mutations` returns `not_member`.

---

## 4. RPC contract

Types: `src/contracts/mutations.ts` (sync RPCs) and `src/contracts/household.ts` (household RPCs).
Every RPC returns `jsonb` with `ok: true | false`; expected failures are **values**
(`{ ok: false, error }`), never raised exceptions. Unexpected exceptions are HTTP errors and the client
treats them as transient.

### 4.1 `apply_mutations(batch jsonb) returns jsonb`

Called as `rpc('apply_mutations', { batch: req })`. Names are stored trimmed. A merge that would take
the target over 99999 is `rejected/invalid`.

Request `ApplyMutationsRequest = { household_id, mutations: Mutation[1..100] }`.

1. `auth.uid()` null → `{ ok:false, error:'not_authenticated' }`. Malformed batch → `invalid_batch`.
2. `select … from public.households where id = household_id for update` — **the household row lock
   serializes all writes of one household**, so `server_seq` values commit in order (no gaps visible
   to readers, no lost increments). Then membership check → `not_member` (whole batch, never retried).
3. For each mutation, in array order:
   - If `private.mutations` has its id: same user → return the stored result with `replayed: true`;
     different user → `rejected/invalid` (not stored).
   - If `household_id` ≠ batch household → `rejected/forbidden`.
   - Resolve `item_id` through `private.item_aliases`.
   - Apply inside a `begin … exception … end` subtransaction. Validation errors (check, not-null,
     numeric range, bad uuid/enum, unknown kind, id that exists in another household) →
     `rejected/invalid`. Any other exception → `status:'retry'` (not stored; logged with `raise warning`).
   - Every row change takes `seq := households.last_seq + 1` (updated in place), sets `server_seq = seq`,
     `updated_at = now()`, `updated_by = auth.uid()`. No-ops do not bump the seq.
   - Store `(id, household_id, user_id, kind, result)` in `private.mutations` for every non-`retry` result.
4. Return `{ ok:true, results, server_seq: households.last_seq }`.

Per kind (server state at receive time decides; client clocks are never used):

| kind | behaviour | status |
|---|---|---|
| `add_item` | (1) id already exists in this household or is an alias → no-op. (2) open item (not checked, not deleted) with same `normalized_name` + `unit` → `quantity += payload.quantity`, alias id→target. (3) checked, non-deleted item with same name+unit (latest `checked_at`) → `checked=false, checked_at=null, quantity = payload.quantity, position = seq` (keeps existing name; note replaced only if payload note non-empty), alias id→target. (4) insert with `position = seq`. | `applied` / `merged` / `restored` / `applied` |
| `update_item` | Per-field LWW: only keys in `fields` are written (`quantity` is an exact set). Target deleted → reject. No dedupe on rename. | `applied` / `rejected deleted|not_found|invalid` |
| `increment_quantity` | `quantity = quantity + delta`; result ≤ 0 or > 99999 → `rejected/invalid`. Deleted → reject. | |
| `set_checked` | sets `checked`, `checked_at = now()` or null; same value → no-op `applied`. Deleted → reject. | |
| `delete_item` | tombstone (`deleted_at = now()`, `deleted_by`). Already deleted → no-op `applied`. Unknown → `not_found`. | |
| `restore_item` | clears tombstone, keeps position. Not deleted → no-op `applied`. | |
| `clear_checked` | tombstones the listed ids that are still `checked` and not deleted; `affected_ids` = those ids. Ids not found/unchecked are skipped silently. | `applied` |

### 4.2 `pull_changes(p_household_id uuid, p_since_seq bigint, p_limit int default 500) returns jsonb`

1. Not authenticated / not member → `{ ok:false, error }`.
2. Read `v_last := households.last_seq` **first** (statement snapshot), then
   `select … from list_items where household_id = p and server_seq > p_since_seq and server_seq <= v_last
   [and deleted_at is null when p_since_seq = 0] order by server_seq limit p_limit + 1`.
   Because writers bump `last_seq` and write rows in the same locked transaction, everything ≤ `v_last` is committed.
3. `has_more` = more than `p_limit` rows. `server_seq` (cursor) = last returned row's seq if `has_more`,
   else `v_last`.
4. `purged_before_seq` is the highest purged tombstone seq. `reset_required = p_since_seq > 0 and
   (p_since_seq < purged_before_seq or p_since_seq > last_seq)` (the second case is a corrupt or foreign
   cursor). When set, the response has `server_seq: 0` and no items; the client wipes `server_items`,
   keeps the outbox and pulls from 0.
   Only the first page of a pull from 0 leaves out tombstones: later pages have `since > 0` and can
   contain tombstones, which clients upsert.
5. Also returns `household` (`HouseholdRow`) so name changes arrive with pulls.

Maintenance (`private.purge(retention)`, run by pg_cron when available, callable from tests): delete
tombstones older than 30 days and bump `purged_before_seq`; delete `private.mutations` older than 90 days;
delete `invite_attempts` older than 2 days.

### 4.3 Household RPCs (online only)

| RPC | Who | Behaviour | Errors |
|---|---|---|---|
| `get_my_household()` | any | household (or null), role, members with `display_name` | |
| `create_household(p_name text default 'Thuis')` | any | Ensure: returns the existing household (`created:false`) if already a member, else creates it with the caller as `owner`. | |
| `create_invite(p_household_id uuid, p_replace bool default false)` | member; replace = owner | Reuse the unrevoked, unexpired invite; else revoke any old one and insert a new random code (`gen_random_bytes`, alphabet `INVITE_CODE_ALPHABET`, retry on collision). Returns `code, expires_at, url = 'https://getkar.nl/j/' || code`. | `not_member`, `not_owner` |
| `preview_invite(p_code text)` | any | Input upper-cased and trimmed. Returns household name, inviter display name, member count, `leaves_current_household`. Counts as an attempt for rate limiting. | `invalid_code`, `expired_code`, `already_member`, `rate_limited` |
| `accept_invite(p_code text)` | any | Locks both households in id order. If the caller is alone in the current household: move its **open** items into the target (dedupe by name+unit → increment + alias; else re-home with a new seq/position), then delete the old household. If the current household has others: leave it (ownership transfer as below), items stay. Insert member row (`member`). | same as preview |
| `leave_household(p_household_id uuid)` | member | Last member → delete household (cascade). Owner with others → longest-standing member (`joined_at`, then `user_id`) becomes owner. Client then wipes local data and calls `create_household()`. | `not_member` |
| `remove_member(p_household_id uuid, p_user_id uuid)` | owner | Deletes the membership and **always revokes the active invite** (next "Deel lijst" makes a new code). | `not_owner`, `cannot_remove_self`, `not_member` |
| `rename_household(p_household_id uuid, p_name text)` | owner | | `not_owner`, `invalid` |
| `delete_account()` | any | Leave with the same rules, then delete the `auth.users` row (cascade). If the `postgres` role cannot delete from `auth.users` on the hosted project, backend adds an Edge Function `delete-account` using the service role; same contract. | |

Rate limits (`private.invite_attempts`, checked in preview and accept): per user 10 per 10 min;
per IP 30 per hour; per code 10 failed per hour; per household 20 failed attempts per hour (attempts on
its expired/revoked codes) blocks joining that household for the rest of the hour → `rate_limited`.

---

## 5. Sync protocol (sync builder, `src/sync/**`)

Contract: `src/contracts/sync.ts`. The engine is UI-agnostic and runs in Node tests with
`better-sqlite3` behind the `SqlDriver` port and a fake or `pg`-backed `SyncTransport`.

### 5.1 Local SQLite schema (`gb-<userId>.db`, `PRAGMA journal_mode = WAL`)

```sql
create table meta (key text primary key, value text not null);          -- schema_version, user_id, household_id, last_seq
create table server_items (                                             -- last confirmed server state (ListItemRow columns)
  id text primary key, household_id text not null, name text not null, normalized_name text not null,
  quantity real not null, unit text not null, note text not null, checked integer not null,
  checked_at text, position integer not null, exclude_from_comparison integer not null,
  created_by text, created_at text not null, updated_by text, updated_at text not null,
  deleted_at text, deleted_by text, server_seq integer not null);
create table outbox (                                                   -- persistent, survives kill/restart/OS update
  seq integer primary key autoincrement, id text not null unique, household_id text not null,
  kind text not null, payload text not null, client_created_at text not null,
  state text not null default 'pending' check (state in ('pending','acked')),
  acked_seq integer, result text, attempts integer not null default 0,
  next_attempt_at integer not null default 0, last_error text);
create table failed_mutations (id text primary key, kind text not null, payload text not null,
  item_name text not null, reason text not null, failed_at integer not null);
create table history (normalized_name text not null, unit text not null, display_name text not null,
  use_count integer not null default 0, last_used_at integer not null, primary key (normalized_name, unit));
create table price_cache (id integer primary key check (id = 1), result text not null,
  list_fingerprint text not null, computed_at integer not null);
-- added by the sync builder:
--   outbox.local_meta text: JSON with the local simulation at enqueue time (undo of a restore needs the
--   previous quantity, which the server result does not carry).
create table acked_log (id text primary key, kind text not null, payload text not null,  -- acked results,
  result text not null, local_meta text, acked_at integer not null);                     -- kept 24 h for revert_add
create table aliases (alias_id text primary key, target_id text not null);               -- mirror of private.item_aliases
```

Engine API: the `SyncEngine` contract includes `dispose()`, `getHousehold()`, `notifyReauthenticated()`
(call when the auth listener sees the same user again or a token refresh), `setAppActive()` (from
AppState) and `readPriceCache()` / `writePriceCache()`. The price cache is only accessed through the
engine, because all access to the per-user DB is serialized by one lock. Undo of "Wissen" is resolved by
the engine from the `clear_checked` result (`affected_ids`).

### 5.2 Write path (optimistic, outbox first)

1. A command (`addItem`, `setChecked`, …) builds a `Mutation` with a fresh uuid, **inserts it into
   `outbox` in a transaction**, and only then recomputes the visible snapshot. Visible within 50 ms.
2. Visible state = `reduce(server_items, outbox rows in seq order)` — a pure reducer in
   `src/sync/reducer.ts` that mirrors the server rules of 4.1 (dedupe on add, delete wins, increments
   as deltas, per-field LWW). Rows that only exist because of pending mutations get `pending: true`.
3. `addItem` **always sends `add_item`** with a new id, even when the local reducer already sees a
   duplicate: the server decides against its own state (it may have been deleted elsewhere). Locally the
   reducer simulates merge/restore so the snackbar can say "Melk +1" / "Melk teruggezet".
4. Undo is an inverse operation on current server state (design-spec 5.6): `revert_add` (resolved from
   the add's result: applied → delete, merged → increment −qty, restored → re-check + previous
   quantity), delete → `restore_item`, check → uncheck, "Wissen" → `restore_item` per `affected_ids`.

### 5.3 Push / pull loop

- **Triggers**: enqueue (debounced ~150 ms), connectivity → online, app foreground, realtime nudge
  (pull only), backoff timer. One loop at a time (mutex).
- **Push**: take up to 100 `pending` outbox rows with `next_attempt_at <= now`, in `seq` order, for the
  current household; call `apply_mutations`.
  - `applied|merged|restored` → `state='acked'`, `acked_seq = result.server_seq ?? response.server_seq`,
    store `result`. If `item_id` differs from the payload target (merge/restore), rewrite later pending
    outbox payloads that target the old id. Acked rows keep being replayed until a pull reaches
    `last_seq >= acked_seq`, then they are deleted (prevents flicker between ack and pull).
  - `rejected` → move to `failed_mutations` (with item name), delete from outbox, icon ⚠. The rest of
    the queue continues (design-spec 5.7).
  - `retry` → `attempts++`, exponential backoff with jitter (1 s, 2 s, 4 s … max 60 s).
  - Transport `TransientSyncError` (network, 5xx, timeout) → whole batch stays pending, backoff.
  - `AuthRequiredError` → `needsReauth = true`; outbox kept; only sent again after the **same user id**
    signs in.
  - `{ ok:false, error:'not_member' }` → stop the loop, copy every outbox row to `failed_mutations`
    with reason `not_member`, fire `onMembershipLost` once. The app shows "Je bent geen lid meer van
    Thuis" ("3 wijzigingen konden niet worden opgeslagen" [Kopieer als tekst]), then wipes.
- **Pull**: `pull_changes(household, meta.last_seq)` until `has_more = false`; upsert rows into
  `server_items` in one transaction per page, then set `meta.last_seq`. `reset_required` → delete
  `server_items`, `last_seq = 0`, pull again (outbox kept). Pull after every successful push, on
  nudge, on foreground, and every 60 s while foregrounded as a safety net.
- **Realtime**: `SyncTransport.subscribe(householdId, onNudge)` subscribes to postgres-changes on
  `list_items` (filter `household_id=eq.<id>`), `households` (`id=eq.<id>`), `household_members`
  (`household_id=eq.<id>`), plus the private broadcast channel `user:<uid>`. Every event → debounced pull.
- **Status** (`SyncStatus.icon`): `offline` when `Connectivity.isOnline()` is false; `error` when
  `failed_mutations` is non-empty; else `idle` (also while sending — no spinner).
- **History**: every `addItem` upserts `history(normalized_name, unit)` (`use_count++`), feeding
  `SuggestionList` together with checked items and the offline NL catalog (mobile).

### 5.4 Required sync tests (`npm run test:sync`)

Kill-and-reopen with a pending outbox (close driver, reopen file, push); two devices adding "melk"
offline → one row with summed quantity; concurrent +1 and +1 → +2; delete vs edit (edit rejected,
`deleted`); exact quantity LWW by server order; "Wissen" only removes on-screen ids that are still
checked; one rejected mutation does not block the rest; replaying a batch after a lost response is
idempotent; `not_member` wipes and reports counts; `reset_required` path; undo of merged add.

---

## 6. Price data model and engine (price builder)

Contract: `src/contracts/price.ts`. Today **no licensed source exists** (`price-provider-verdict.md`):
`price_sources` is seeded with `open_prices` (ODbL) with `verified_for_consumer_display = false`; no
observations are seeded. The tab therefore renders state `unavailable`:
**"Geen geverifieerde prijzen beschikbaar"** / "We laten liever niets zien dan een verkeerde vergelijking."
No toggle, no button, no numbers.

### 6.1 Schema (`20261023001000_prices.sql`)

```sql
create table public.price_sources (
  id text primary key, name text not null, licence text not null, licence_url text, attribution text,
  channel text not null check (channel in ('national','webshop')),
  verified_for_consumer_display boolean not null default false);
create table public.chains (id text primary key, name text not null);
create table public.catalog_items (
  id text primary key, display_name text not null, aliases text[] not null default '{}',   -- normalized names
  reference_quantity numeric(12,3) not null check (reference_quantity > 0),
  reference_unit text not null check (reference_unit in ('g','ml','stuk')));
create table public.products (
  id uuid primary key default gen_random_uuid(),
  ean text not null check (ean ~ '^[0-9]{8}$|^[0-9]{12,14}$'),
  chain_id text references public.chains(id),            -- private label: per-chain EAN
  name text not null, brand text,
  net_content numeric(12,3) not null check (net_content > 0),
  net_content_unit text not null check (net_content_unit in ('g','ml','stuk')),
  unique (ean, chain_id));
create table public.catalog_product_links (                -- pre-approved EAN link per chain
  catalog_item_id text not null references public.catalog_items(id) on delete cascade,
  chain_id text not null references public.chains(id),
  product_id uuid not null references public.products(id) on delete cascade,
  confidence numeric(3,2) not null check (confidence between 0 and 1),
  approved_by text not null, approved_at timestamptz not null default now(),
  primary key (catalog_item_id, chain_id, product_id));
create table public.price_observations (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  chain_id text not null references public.chains(id),
  source_id text not null references public.price_sources(id),
  price_cents integer not null check (price_cents > 0),     -- never 0: unknown is a missing row
  unit_price_cents integer, unit_price_unit text check (unit_price_unit in ('g','ml','stuk')),
  promotion jsonb, promotion_valid_until timestamptz,
  requires_loyalty boolean not null default false,
  observed_at timestamptz,                                  -- null => unknown
  ingested_at timestamptz not null default now());
create index on public.price_observations(product_id, chain_id, observed_at desc);
create table public.price_match_overrides (                 -- "Verkeerd product", household-wide, reversible
  household_id uuid not null references public.households(id) on delete cascade,
  catalog_item_id text not null references public.catalog_items(id) on delete cascade,
  chain_id text not null references public.chains(id),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (household_id, catalog_item_id, chain_id));
```

### 6.2 Engine rules (`src/price/engine.ts`, pure, injected `now`)

1. **One question per item**: list item → catalog item by exact `normalized_name ∈ aliases`. No match →
   `unknown` at every store. The note never counts.
2. **Required quantity** in the catalog's base unit: `stuk` → `quantity × reference_quantity`;
   `kg`→g ×1000, `l`→ml ×1000; dimension mismatch with `reference_unit` → `unknown`.
3. **Status** per (item, chain): candidate products = links for that catalog item and chain with
   `confidence ≥ 0.9`, not overridden for the household; latest observation per product from a source with
   `verified_for_consumer_display`, a national/webshop channel, and `requires_loyalty = false`.
   No `observed_at` → unknown. Age ≤ 7 d → `verified`; 7–14 d → `stale` ("4 d oud", counts);
   > 14 d → `unknown`. No estimates ever.
4. **Packaging**: for every candidate product, `n = ceil(required / net_content)`; cost = `n × price_cents`
   or the promotion price if `n` reaches the promotion and it is still valid (multi-buy:
   `floor(n/min)×total + (n mod min)×price`; x+y: pay `n − floor(n/(x+y))×y` packages). Pick the lowest
   cost; tie → smallest overage. Report overage when > 25%.
5. **Complete** = every compared (non-excluded) item is `verified` or `stale`. Only complete baskets
   get `total_cents` and are ranked ascending; the top one is `cheapest`, or `only_complete` if alone.
   Incomplete baskets show `priced_count` of `compared_count` and **no total**. Unknown never counts as 0.
6. **State**: fewer than 2 chains with a *fresh* (≤ 14 d, i.e. verified or stale) verified-source
   observation → `unavailable` (v1 today);
   no compared items → `empty`; ≥ 1 complete → `ranked`; else `no_complete`.
7. Integer cents throughout; deposit (statiegeld) excluded. Detergents count wasbeurten as `stuk`
   (reference 20 = 20 wasbeurten). Each `BasketLine` carries `unit_price` (shelf price per kg / l / stuk of
   the chosen package) and `promotion_valid_until` (only when a promotion was applied). Single-store baskets only: 2/3-store routes
   and subscriptions are deferred.
8. **Cache**: last result in `price_cache` with `list_fingerprint`; if the current fingerprint differs,
   drop the "Goedkoopste" label and show "Je lijst is gewijzigd sinds 10:42".
9. Items compared = open + checked until "Wissen" (checking items off in the store does not reorder stores).

Required price tests: unknown never zero; incomplete never ranked or totalled; EAN-only matching (two
350 g variants with different EANs never cross-match); package selection incl. tie-break and overage;
promotions threshold; 7/14-day boundaries; missing `observed_at`; override makes a store incomplete;
`unavailable` with 0 or 1 verified chains.

---

## 7. Mobile notes (mobile builder)

- Tokens: `src/ui/tokens.ts` (design-spec 2), `useColors()` in `src/ui/theme.ts`. One accent; status
  colours always with icon/word. Amounts via `Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' })`,
  `fontVariant: ['tabular-nums']`.
- Routes (planned): `app/(tabs)/index.tsx` Mijn lijst, `app/(tabs)/route.tsx` Goedkoopste route,
  `app/sign-in.tsx`, `app/household.tsx`, `app/j/[code].tsx`, item detail and sheets as modals.
- Quick-add parser `src/shared/quantity.ts` implements `ParsedEntry` (`"2 melk"`, `"melk 2"`, `"500 g gehakt"`,
  `"3x brood"`, `"1,5 l melk"`), plus `formatQuantity(q, unit)` (nothing for 1 stuk, decimal comma).
- The "nothing moves under your finger" layer (1.5 s settle, scroll compensation) lives in the UI, on
  top of `ListSnapshot`.
- Web export is for visual inspection only: `createBackend.web.ts` always uses the in-memory demo backend
  (`src/lib/demo`, `DirectEngine` on the sync builder's `FakeServer`). Device builds always use Supabase +
  the real sync engine (expo-sqlite, NetInfo) and do not bundle the demo; a device build without
  Supabase configuration shows a configuration error instead of silently falling back to demo data.
- `react-native-url-polyfill/auto` is imported first in `app/_layout.tsx` (supabase-js on Hermes).

---

## 8. Security checklist

- RLS on every public table; no direct client writes; `anon` has no grants.
- Every `security definer` function: `set search_path = ''`, checks `auth.uid()`, checks membership/role.
- Invite codes: 6 chars from a 32-symbol alphabet (~1.07 billion combinations), 7-day expiry, rate limited per
  user/IP/code/household, revoked on member removal.
- Client-generated ids are untrusted: an id that exists in another household is rejected without leaking.
- Per-user SQLite file, wiped on logout/leave/removal; session tokens only in SecureStore.
- No analytics, ads or promotional push.

---

## 9. Changing contracts

`src/contracts/**` is the integration surface. If a builder needs a change, they describe it to the
architect (what, why, which callers). The architect updates the contract and this document in one
commit. Builders may add internal types inside their own folders freely.
