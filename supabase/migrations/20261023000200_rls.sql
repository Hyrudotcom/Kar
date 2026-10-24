-- Row level security: strict separation between households (docs/architecture.md 3.1).
-- Reads are membership based; writes go through security definer RPCs only.

alter table public.profiles          enable row level security;
alter table public.households        enable row level security;
alter table public.household_members enable row level security;
alter table public.invites           enable row level security;
alter table public.list_items        enable row level security;

-- Start from nothing, then grant exactly what clients may do.
revoke all on public.profiles, public.households, public.household_members, public.invites, public.list_items
  from public, anon, authenticated;
grant all on public.profiles, public.households, public.household_members, public.invites, public.list_items
  to service_role;

grant select on public.households, public.household_members, public.list_items to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, price_comparison_enabled) on public.profiles to authenticated;
-- public.invites: no client grant at all. Codes are only handed out by create_invite and
-- resolved by preview_invite / accept_invite.

create policy profiles_select on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()) or private.shares_household(user_id));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy households_select on public.households
  for select to authenticated
  using (private.is_member(id));

create policy household_members_select on public.household_members
  for select to authenticated
  using (private.is_member(household_id));

create policy list_items_select on public.list_items
  for select to authenticated
  using (private.is_member(household_id));

-- Invites: RLS on with no policy = invisible even if a grant were added by mistake.
