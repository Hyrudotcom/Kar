-- Price data model (owner: price builder). See docs/architecture.md section 6 and
-- src/contracts/price.ts. Engine: src/price/engine.ts.
--
-- Hard rules enforced here as defense in depth (the engine enforces them too):
--   * reference tables are read-only for `authenticated`; only service_role ingestion writes them
--   * anon has no access at all
--   * a price is never 0 (unknown = no row), money in integer cents
--   * products are identified by a valid GTIN; matching is only via pre-approved per-chain links
--   * a private-label product (chain_id set) can only be linked to / observed at its own chain
--   * a link must use the same base unit as its catalog item (no per kg vs per tros comparisons)
--   * NO price data is seeded. Open Prices is registered with verified_for_consumer_display = false
--     (discovery/price-provider-verdict.md), so the app shows "Geen geverifieerde prijzen beschikbaar".

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- GS1 mod-10 check digit for GTIN-8/12/13/14. Mirrors src/price/ean.ts isValidGtin.
create or replace function public.gb_valid_gtin(p text) returns boolean
language sql immutable strict parallel safe set search_path = '' as $$
  select p ~ '^([0-9]{8}|[0-9]{12,14})$'
     and (10 - (select pg_catalog.sum(pg_catalog.substr(p, pg_catalog.length(p) - i, 1)::int
                                       * case when i % 2 = 1 then 3 else 1 end)
                  from pg_catalog.generate_series(1, pg_catalog.length(p) - 1) as i) % 10) % 10
         = pg_catalog.right(p, 1)::int
$$;
revoke all on function public.gb_valid_gtin(text) from public, anon;
grant execute on function public.gb_valid_gtin(text) to authenticated, service_role;

-- Shape of public.price_observations.promotion (contract type Promotion).
create or replace function public.gb_valid_promotion(p jsonb) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select case
    when p is null then true
    when pg_catalog.jsonb_typeof(p) <> 'object' then false
    when p->>'type' = 'multi_buy' then
         pg_catalog.jsonb_typeof(p->'min_quantity') = 'number' and pg_catalog.jsonb_typeof(p->'total_cents') = 'number'
     and (p->>'min_quantity') ~ '^[0-9]+$' and (p->>'total_cents') ~ '^[0-9]+$'
     and (p->>'min_quantity')::bigint >= 2 and (p->>'total_cents')::bigint between 1 and 2147483647
    when p->>'type' = 'x_plus_y' then
         pg_catalog.jsonb_typeof(p->'buy') = 'number' and pg_catalog.jsonb_typeof(p->'free') = 'number'
     and (p->>'buy') ~ '^[0-9]+$' and (p->>'free') ~ '^[0-9]+$'
     and (p->>'buy')::bigint between 1 and 1000 and (p->>'free')::bigint between 1 and 1000
    else false
  end
$$;
revoke all on function public.gb_valid_promotion(jsonb) from public, anon;
grant execute on function public.gb_valid_promotion(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.price_sources (
  id                            text primary key check (id ~ '^[a-z0-9_]{2,40}$'),
  name                          text not null check (char_length(btrim(name)) between 1 and 120),
  licence                       text not null check (char_length(btrim(licence)) between 1 and 120),
  licence_url                   text,
  attribution                   text,
  channel                       text not null check (channel in ('national', 'webshop')),
  -- Only true after a signed licence that allows consumer display. False for everything today.
  verified_for_consumer_display boolean not null default false
);

create table public.chains (
  id   text primary key check (id ~ '^[a-z0-9_]{2,20}$'),
  name text not null check (char_length(btrim(name)) between 1 and 60)
);

create table public.catalog_items (
  id                 text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  display_name       text not null check (char_length(btrim(display_name)) between 1 and 120),
  aliases            text[] not null default '{}',   -- normalized with gb_normalize_name (trigger)
  reference_quantity numeric(12,3) not null check (reference_quantity > 0),
  reference_unit     text not null check (reference_unit in ('g', 'ml', 'stuk'))
);
create index catalog_items_aliases_gin on public.catalog_items using gin (aliases);

create table public.products (
  id               uuid primary key default gen_random_uuid(),
  ean              text not null check (public.gb_valid_gtin(ean)),
  chain_id         text references public.chains(id),   -- private label: per-chain EAN; null = brand product
  name             text not null check (char_length(btrim(name)) between 1 and 200),
  brand            text,
  net_content      numeric(12,3) not null check (net_content > 0),
  net_content_unit text not null check (net_content_unit in ('g', 'ml', 'stuk')),
  constraint products_ean_chain_key unique nulls not distinct (ean, chain_id)
);

create table public.catalog_product_links (               -- pre-approved EAN link per chain
  catalog_item_id text not null references public.catalog_items(id) on delete cascade,
  chain_id        text not null references public.chains(id),
  product_id      uuid not null references public.products(id) on delete cascade,
  confidence      numeric(3,2) not null check (confidence between 0 and 1),
  approved_by     text not null check (char_length(btrim(approved_by)) > 0),
  approved_at     timestamptz not null default now(),
  primary key (catalog_item_id, chain_id, product_id)
);
create index catalog_product_links_product on public.catalog_product_links(product_id);

create table public.price_observations (
  id                    uuid primary key default gen_random_uuid(),
  product_id            uuid not null references public.products(id) on delete cascade,
  chain_id              text not null references public.chains(id),
  source_id             text not null references public.price_sources(id),
  price_cents           integer not null check (price_cents > 0),   -- never 0: unknown is a missing row
  unit_price_cents      integer check (unit_price_cents > 0),
  unit_price_unit       text check (unit_price_unit in ('g', 'ml', 'stuk')),
  promotion             jsonb check (public.gb_valid_promotion(promotion)),
  promotion_valid_until timestamptz,
  requires_loyalty      boolean not null default false,
  observed_at           timestamptz,                                -- null => unknown
  ingested_at           timestamptz not null default now(),
  constraint price_observations_unit_price_pair check ((unit_price_cents is null) = (unit_price_unit is null)),
  constraint price_observations_promotion_until check (promotion is not null or promotion_valid_until is null)
);
create index price_observations_latest on public.price_observations(product_id, chain_id, observed_at desc);
create index price_observations_chain on public.price_observations(chain_id);
create index price_observations_source on public.price_observations(source_id);

create table public.price_match_overrides (                 -- "Verkeerd product", household-wide, reversible
  household_id    uuid not null references public.households(id) on delete cascade,
  catalog_item_id text not null references public.catalog_items(id) on delete cascade,
  chain_id        text not null references public.chains(id) on delete cascade,
  created_by      uuid default auth.uid() references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  primary key (household_id, catalog_item_id, chain_id)
);
create index price_match_overrides_created_by on public.price_match_overrides(created_by);

-- ---------------------------------------------------------------------------
-- Integrity triggers (ingestion mistakes must fail loudly, not show a wrong comparison)
-- ---------------------------------------------------------------------------
create function private.prices_catalog_items_normalize() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_clash text;
begin
  new.aliases := coalesce((select pg_catalog.array_agg(distinct a order by a)
                             from (select public.gb_normalize_name(x) as a from pg_catalog.unnest(new.aliases) as x) s
                            where a is not null and a <> ''), '{}');
  -- one alias = one catalog item (design-spec 4.5 rule 1: one question per item)
  select c.id into v_clash from public.catalog_items c
   where c.id <> new.id and c.aliases && new.aliases limit 1;
  if v_clash is not null then
    raise exception 'alias already used by catalog item %', v_clash using errcode = '23505';
  end if;
  return new;
end
$$;
create trigger catalog_items_normalize before insert or update of aliases, id on public.catalog_items
  for each row execute function private.prices_catalog_items_normalize();

create function private.prices_links_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_ref_unit text;
  v_prod     public.products%rowtype;
begin
  select reference_unit into v_ref_unit from public.catalog_items where id = new.catalog_item_id;
  select * into v_prod from public.products where id = new.product_id;
  if v_ref_unit is null or v_prod.id is null then
    return new; -- foreign keys report the missing row
  end if;
  if v_prod.net_content_unit <> v_ref_unit then
    raise exception 'link unit mismatch: product % is per %, catalog item % is per %',
      new.product_id, v_prod.net_content_unit, new.catalog_item_id, v_ref_unit using errcode = '23514';
  end if;
  if v_prod.chain_id is not null and v_prod.chain_id <> new.chain_id then
    raise exception 'private label product % belongs to chain %, not %', new.product_id, v_prod.chain_id, new.chain_id
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger catalog_product_links_check before insert or update on public.catalog_product_links
  for each row execute function private.prices_links_check();

-- Changing a product's unit or chain must not silently invalidate existing links.
create function private.prices_products_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.catalog_product_links l
               join public.catalog_items c on c.id = l.catalog_item_id
              where l.product_id = new.id
                and (c.reference_unit <> new.net_content_unit
                     or (new.chain_id is not null and new.chain_id <> l.chain_id))) then
    raise exception 'product % change conflicts with existing catalog links', new.id using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger products_check before update of net_content_unit, chain_id on public.products
  for each row execute function private.prices_products_check();

create function private.prices_catalog_unit_check() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.catalog_product_links l
               join public.products p on p.id = l.product_id
              where l.catalog_item_id = new.id and p.net_content_unit <> new.reference_unit) then
    raise exception 'catalog item % unit change conflicts with existing links', new.id using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger catalog_items_unit_check before update of reference_unit on public.catalog_items
  for each row execute function private.prices_catalog_unit_check();

create function private.prices_observations_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_chain text;
begin
  select chain_id into v_chain from public.products where id = new.product_id;
  if v_chain is not null and v_chain <> new.chain_id then
    raise exception 'private label product % cannot be observed at chain %', new.product_id, new.chain_id
      using errcode = '23514';
  end if;
  if new.observed_at is not null and new.observed_at > now() + interval '5 minutes' then
    raise exception 'observed_at lies in the future' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger price_observations_check before insert or update on public.price_observations
  for each row execute function private.prices_observations_check();

revoke all on function private.prices_catalog_items_normalize() from public, anon, authenticated;
revoke all on function private.prices_links_check() from public, anon, authenticated;
revoke all on function private.prices_products_check() from public, anon, authenticated;
revoke all on function private.prices_catalog_unit_check() from public, anon, authenticated;
revoke all on function private.prices_observations_check() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Privileges + RLS (docs/architecture.md 3.1)
-- ---------------------------------------------------------------------------
alter table public.price_sources         enable row level security;
alter table public.chains                enable row level security;
alter table public.catalog_items         enable row level security;
alter table public.products              enable row level security;
alter table public.catalog_product_links enable row level security;
alter table public.price_observations    enable row level security;
alter table public.price_match_overrides enable row level security;

revoke all on public.price_sources, public.chains, public.catalog_items, public.products,
              public.catalog_product_links, public.price_observations, public.price_match_overrides
  from public, anon, authenticated;
grant all on public.price_sources, public.chains, public.catalog_items, public.products,
             public.catalog_product_links, public.price_observations, public.price_match_overrides
  to service_role;

-- Reference data: read-only for signed-in users, writes only via service_role (bypasses RLS).
grant select on public.price_sources, public.chains, public.catalog_items, public.products,
                public.catalog_product_links, public.price_observations
  to authenticated;

create policy price_sources_read         on public.price_sources         for select to authenticated using (true);
create policy chains_read                on public.chains                for select to authenticated using (true);
create policy catalog_items_read         on public.catalog_items         for select to authenticated using (true);
create policy products_read              on public.products              for select to authenticated using (true);
create policy catalog_product_links_read on public.catalog_product_links for select to authenticated using (true);
create policy price_observations_read    on public.price_observations    for select to authenticated using (true);

-- "Verkeerd product": members of the household only. created_by/created_at are not client writable.
grant select, delete on public.price_match_overrides to authenticated;
grant insert (household_id, catalog_item_id, chain_id) on public.price_match_overrides to authenticated;

create policy price_match_overrides_select on public.price_match_overrides
  for select to authenticated
  using (private.is_member(household_id));

create policy price_match_overrides_insert on public.price_match_overrides
  for insert to authenticated
  with check (private.is_member(household_id) and created_by = (select auth.uid()));

create policy price_match_overrides_delete on public.price_match_overrides
  for delete to authenticated
  using (private.is_member(household_id));

-- ---------------------------------------------------------------------------
-- Reference rows (NOT prices). No observations, products or links are seeded.
-- ---------------------------------------------------------------------------
insert into public.price_sources (id, name, licence, licence_url, attribution, channel, verified_for_consumer_display)
values ('open_prices', 'Open Prices (Open Food Facts)', 'ODbL-1.0', 'https://opendatacommons.org/licenses/odbl/1-0/',
        'Open Food Facts contributors', 'national', false)
on conflict (id) do nothing;

insert into public.chains (id, name) values
  ('ah', 'Albert Heijn'), ('jumbo', 'Jumbo'), ('plus', 'Plus'), ('lidl', 'Lidl'),
  ('aldi', 'Aldi'), ('dirk', 'Dirk'), ('picnic', 'Picnic'), ('coop', 'Coop')
on conflict (id) do nothing;
