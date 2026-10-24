-- Kar core schema (owner: backend). See docs/architecture.md section 3.
-- Clients never write tables directly: every write goes through the RPCs in 000300_rpcs.sql.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;   -- only so RLS policies can call private.is_member

-- anon gets nothing, also for objects later migrations create in public (as postgres).
-- authenticated/service_role keep the Supabase defaults; each table revokes what it must.
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;
-- PUBLIC execute on new functions is a global default (schema-scoped revokes cannot remove it).
-- authenticated/service_role keep execute in public through Supabase's schema-scoped defaults.
alter default privileges for role postgres revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Name normalization. MUST equal src/shared/normalize.ts (NFKD, strip U+0300-036F, lower,
-- collapse whitespace, trim). Vectors: NORMALIZE_VECTORS, asserted in supabase/tests.
-- ---------------------------------------------------------------------------
create or replace function public.gb_normalize_name(p text) returns text
language sql immutable strict parallel safe set search_path = '' as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(
           pg_catalog.regexp_replace(normalize(p, NFKD), '[̀-ͯ]', '', 'g')),
         '\s+', ' ', 'g'))
$$;
revoke all on function public.gb_normalize_name(text) from public, anon;
grant execute on function public.gb_normalize_name(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id                  uuid primary key references auth.users(id) on delete cascade,
  display_name             text not null default '' check (char_length(display_name) <= 60),
  price_comparison_enabled boolean not null default false,
  created_at               timestamptz not null default now()
);

create table public.households (
  id                uuid primary key default gen_random_uuid(),
  name              text not null default 'Thuis' check (char_length(btrim(name)) between 1 and 60),
  created_at        timestamptz not null default now(),
  last_seq          bigint not null default 0 check (last_seq >= 0),
  purged_before_seq bigint not null default 0 check (purged_before_seq >= 0)
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('owner', 'member')),
  joined_at    timestamptz not null default clock_timestamp(),
  primary key (household_id, user_id)
);
create unique index household_members_one_per_user on public.household_members(user_id);
create unique index household_members_one_owner    on public.household_members(household_id) where role = 'owner';

create table public.invites (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  code         text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '7 days'),
  revoked_at   timestamptz
);
create unique index invites_one_unrevoked on public.invites(household_id) where revoked_at is null;

create table public.list_items (
  id                      uuid primary key,
  household_id            uuid not null references public.households(id) on delete cascade,
  name                    text not null check (char_length(btrim(name)) between 1 and 120),
  normalized_name         text generated always as (public.gb_normalize_name(name)) stored,
  quantity                numeric(12,3) not null default 1 check (quantity > 0 and quantity <= 99999),
  unit                    text not null default 'stuk' check (unit in ('stuk','g','kg','ml','l')),
  note                    text not null default '' check (char_length(note) <= 140),
  checked                 boolean not null default false,
  checked_at              timestamptz,
  position                bigint not null,
  exclude_from_comparison boolean not null default false,
  created_by              uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_by              uuid references auth.users(id) on delete set null,
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  deleted_by              uuid references auth.users(id) on delete set null,
  server_seq              bigint not null
);
create index list_items_pull   on public.list_items(household_id, server_seq);
create index list_items_dedupe on public.list_items(household_id, normalized_name, unit) where deleted_at is null;
-- Deliberately NO unique index on (normalized_name, unit): renames may create duplicates (design-spec F41).

-- Idempotency log, keyed by client mutation id. Retained 90 days (private.purge).
create table private.mutations (
  id           uuid primary key,
  household_id uuid not null,
  user_id      uuid not null,
  kind         text not null,
  result       jsonb not null,
  received_at  timestamptz not null default now()
);
create index mutations_received_at on private.mutations(received_at);
create index mutations_user on private.mutations(user_id);

-- add_item that merged/restored into another row: later mutations on the alias are redirected.
create table private.item_aliases (
  alias_id     uuid primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  target_id    uuid not null references public.list_items(id) on delete cascade,
  created_at   timestamptz not null default now()
);
create index item_aliases_target on private.item_aliases(target_id);
create index item_aliases_household on private.item_aliases(household_id);

create table private.invite_attempts (
  id           bigserial primary key,
  user_id      uuid,
  ip           text,
  code         text not null,
  household_id uuid,
  success      boolean not null,
  at           timestamptz not null default now()
);
create index invite_attempts_at on private.invite_attempts(at);
create index invite_attempts_user on private.invite_attempts(user_id, at);
create index invite_attempts_ip on private.invite_attempts(ip, at);
create index invite_attempts_code on private.invite_attempts(code, at);
create index invite_attempts_household on private.invite_attempts(household_id, at);

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Membership helpers (used by RLS policies)
-- ---------------------------------------------------------------------------
create function private.is_member(p_household uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.household_members m
                 where m.household_id = p_household and m.user_id = (select auth.uid()))
$$;

create function private.shares_household(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1
                   from public.household_members me
                   join public.household_members other on other.household_id = me.household_id
                  where me.user_id = (select auth.uid()) and other.user_id = p_user)
$$;

revoke all on function private.is_member(uuid) from public, anon;
revoke all on function private.shares_household(uuid) from public, anon;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.shares_household(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Profile row for every new auth user
-- ---------------------------------------------------------------------------
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, display_name)
  values (
    new.id,
    left(btrim(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
                        nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
                        split_part(coalesce(new.email, ''), '@', 1),
                        '')), 60)
  )
  on conflict (user_id) do nothing;
  return new;
end
$$;
revoke all on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();
