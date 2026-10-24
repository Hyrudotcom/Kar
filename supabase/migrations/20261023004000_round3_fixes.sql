-- Round 3 review fixes (server side).
--  * apply_mutations: a replayed mutation id is answered from the log only within the same
--    household. After a household switch the client re-sends its outbox to the new household; the
--    old household's result (its item id and server_seq) made the client show a ghost row.
--  * check_invite: the global ceiling no longer refuses accounts without a failed lookup, so
--    twenty throwaway accounts cannot block every valid invitation in the app.
--  * preview_invite no longer shows an e-mail derived name; Apple's real name fills the profile.

create or replace function public.apply_mutations(batch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid       uuid := auth.uid();
  v_household uuid;
  v_m         jsonb;
  v_mid       uuid;
  v_mh        uuid;
  v_kind      text;
  v_prev      private.mutations;
  v_res       jsonb;
  v_results   jsonb := '[]'::jsonb;
  v_n         int;
  v_stopped   boolean := false;
begin
  if v_uid is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  -- Shape of the whole batch. Anything wrong here rejects the batch, nothing is applied.
  if pg_catalog.jsonb_typeof(batch) is distinct from 'object'
     or pg_catalog.jsonb_typeof(batch -> 'household_id') is distinct from 'string'
     or pg_catalog.jsonb_typeof(batch -> 'mutations') is distinct from 'array' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_batch');
  end if;
  v_n := pg_catalog.jsonb_array_length(batch -> 'mutations');
  if v_n < 1 or v_n > 100 then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_batch');
  end if;
  begin
    v_household := (batch ->> 'household_id')::uuid;
    for v_m in select pg_catalog.jsonb_array_elements(batch -> 'mutations') loop
      if pg_catalog.jsonb_typeof(v_m) is distinct from 'object'
         or pg_catalog.jsonb_typeof(v_m -> 'id') is distinct from 'string' then
        return pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_batch');
      end if;
      v_mid := (v_m ->> 'id')::uuid;
    end loop;
  exception when invalid_text_representation then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid_batch');
  end;

  -- The household row lock serializes all writes of one household.
  perform 1 from public.households h where h.id = v_household for update;
  if not found or not exists (select 1 from public.household_members m
                               where m.household_id = v_household and m.user_id = v_uid) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_member');
  end if;

  for v_m in select pg_catalog.jsonb_array_elements(batch -> 'mutations') loop
    v_mid := (v_m ->> 'id')::uuid;

    select * into v_prev from private.mutations pm where pm.id = v_mid;
    if found then
      if v_prev.user_id <> v_uid then
        v_res := pg_catalog.jsonb_build_object('id', v_mid, 'status', 'rejected', 'reason', 'invalid');
      elsif v_prev.household_id = v_household then
        v_res := v_prev.result || '{"replayed": true}'::jsonb;
      else
        -- Applied in the household this user left; accept_invite already moved/merged its effect
        -- into this household. The old result (item id, server_seq) belongs to the other household
        -- and must never reach the client: report it as done here, without ids or a seq.
        v_res := pg_catalog.jsonb_build_object('id', v_mid, 'status', 'applied', 'replayed', true);
      end if;
      v_results := v_results || pg_catalog.jsonb_build_array(v_res);
      continue;
    end if;

    -- After a 'retry', nothing later in the batch is applied: a later mutation may depend on the
    -- retried one (e.g. an add of the same name after a delete or rename), and the client sends the
    -- batch in order. The client resends them; their ids are not recorded.
    if v_stopped then
      v_results := v_results || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('id', v_mid, 'status', 'retry'));
      continue;
    end if;

    v_kind := case when pg_catalog.jsonb_typeof(v_m -> 'kind') = 'string' then v_m ->> 'kind' end;
    begin
      if pg_catalog.jsonb_typeof(v_m -> 'household_id') is distinct from 'string' then
        perform private.invalid('household_id');
      end if;
      v_mh := (v_m ->> 'household_id')::uuid;
      if v_mh <> v_household then
        v_res := private.rejected('forbidden', null);
      elsif pg_catalog.jsonb_typeof(v_m -> 'payload') is distinct from 'object' then
        perform private.invalid('payload');
      else
        v_res := case v_kind
          when 'add_item'           then private.m_add_item(v_household, v_uid, v_m -> 'payload')
          when 'update_item'        then private.m_update_item(v_household, v_uid, v_m -> 'payload')
          when 'increment_quantity' then private.m_increment_quantity(v_household, v_uid, v_m -> 'payload')
          when 'set_checked'        then private.m_set_checked(v_household, v_uid, v_m -> 'payload')
          when 'delete_item'        then private.m_delete_item(v_household, v_uid, v_m -> 'payload')
          when 'restore_item'       then private.m_restore_item(v_household, v_uid, v_m -> 'payload')
          when 'clear_checked'      then private.m_clear_checked(v_household, v_uid, v_m -> 'payload')
        end;
        if v_res is null then perform private.invalid('unknown kind'); end if;
      end if;
    exception
      when sqlstate 'GB001' or data_exception or integrity_constraint_violation then
        v_res := private.rejected('invalid', null);
      when others then
        raise warning 'apply_mutations: mutation % (%) failed: % %', v_mid, v_kind, sqlstate, sqlerrm;
        v_res := pg_catalog.jsonb_build_object('status', 'retry');
    end;

    v_res := pg_catalog.jsonb_build_object('id', v_mid) || v_res;
    if v_res ->> 'status' = 'retry' then
      v_stopped := true;
    else
      insert into private.mutations (id, household_id, user_id, kind, result)
      values (v_mid, v_household, v_uid, coalesce(pg_catalog.left(v_kind, 40), ''), v_res)
      on conflict (id) do nothing;
    end if;
    v_results := v_results || pg_catalog.jsonb_build_array(v_res);
  end loop;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'results', v_results,
    'server_seq', (select h.last_seq from public.households h where h.id = v_household));
end
$$;

create or replace function private.check_invite(p_uid uuid, p_code text, out error text, out invite public.invites)
language plpgsql volatile set search_path = '' as $$
declare
  v_ip   text := private.request_ip();
  v_code text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, '')));
begin
  if (select count(*) from private.invite_attempts a
       where a.user_id = p_uid and a.at > now() - interval '10 minutes') >= 10
     or (v_ip is not null and (select count(*) from private.invite_attempts a
                                where a.ip = v_ip and a.at > now() - interval '1 hour') >= 30)
     or (select count(*) from private.invite_attempts a
          where a.code = v_code and not a.success and a.at > now() - interval '1 hour') >= 10
     -- An account that keeps guessing (new IPs do not help): 30 failed lookups per day.
     or (select count(*) from private.invite_attempts a
          where a.user_id = p_uid and not a.success and a.at > now() - interval '24 hours') >= 30
     -- Guessing spread over many accounts and IPs: a global ceiling on lookups of unknown codes.
     -- It only applies to accounts that already failed a lookup today: someone opening a real link
     -- has no failures and is never locked out by other accounts (round 3).
     or ((select count(*) from private.invite_attempts a
           where a.household_id is null and not a.success and a.at > now() - interval '10 minutes') >= 200
         and exists (select 1 from private.invite_attempts a
                      where a.user_id = p_uid and not a.success and a.at > now() - interval '24 hours')) then
    -- Not logged: a refused request is no lookup, and must not extend any limit.
    error := 'rate_limited';
    return;
  end if;

  if v_code !~ '^[A-HJ-NP-Z2-9]{6}$' then
    perform private.log_attempt(p_uid, v_ip, v_code, null, false);
    error := 'invalid_code';
    return;
  end if;

  select * into invite from public.invites i where i.code = v_code;
  if not found then
    perform private.log_attempt(p_uid, v_ip, v_code, null, false);
    error := 'invalid_code';
    return;
  end if;

  if invite.revoked_at is not null or invite.expires_at <= now() then
    perform private.log_attempt(p_uid, v_ip, v_code, invite.household_id, false);
    error := 'expired_code';
    invite := null;
    return;
  end if;

  perform private.log_attempt(p_uid, v_ip, v_code, invite.household_id, true);
  if exists (select 1 from public.household_members m
              where m.household_id = invite.household_id and m.user_id = p_uid) then
    error := 'already_member';
    invite := null;
  end if;
end
$$;
revoke all on function private.check_invite(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Names. An e-mail code sign-up gets the address's local part as display name (and Apple's
-- "Hide my email" a random relay string). Anyone holding an invite code saw it as inviter_name.
--  * private.public_name(): '' for a name that is just the e-mail local part.
--  * Apple sends the real name only after sign-in (updateUser full_name): it now fills a profile
--    name that is empty or e-mail derived.
-- ---------------------------------------------------------------------------
create or replace function private.public_name(p_uid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
           when pg_catalog.lower(p.display_name)
                = pg_catalog.lower(pg_catalog.left(pg_catalog.split_part(coalesce(u.email, ''), '@', 1), 60)) then ''
           else p.display_name
         end
    from public.profiles p
    left join auth.users u on u.id = p.user_id
   where p.user_id = p_uid
$$;
revoke all on function private.public_name(uuid) from public, anon, authenticated;

create or replace function public.preview_invite(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_chk     record;
  v_cur     uuid;
  v_others  int := 0;
begin
  if v_uid is null then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_chk from private.check_invite(v_uid, p_code);
  if v_chk.error is not null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', v_chk.error);
  end if;

  select m.household_id into v_cur from public.household_members m where m.user_id = v_uid;
  if v_cur is not null then
    select count(*) into v_others from public.household_members m
     where m.household_id = v_cur and m.user_id <> v_uid;
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'household_id', (v_chk.invite).household_id,
    'household_name', (select h.name from public.households h where h.id = (v_chk.invite).household_id),
    'inviter_name', coalesce(
        (select nullif(private.public_name(m.user_id), '') from public.household_members m
          where m.user_id = (v_chk.invite).created_by and m.household_id = (v_chk.invite).household_id),
        (select private.public_name(m.user_id) from public.household_members m
          where m.household_id = (v_chk.invite).household_id and m.role = 'owner'),
        ''),
    'member_count', (select count(*) from public.household_members m
                      where m.household_id = (v_chk.invite).household_id),
    'leaves_current_household', v_others > 0,
    'current_household_name', (select h.name from public.households h where h.id = v_cur));
end
$$;

create or replace function private.handle_user_name_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_name text := pg_catalog.left(pg_catalog.btrim(coalesce(
                   nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name'), ''),
                   nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'name'), ''), '')), 60);
begin
  if v_name <> '' then
    update public.profiles p set display_name = v_name
     where p.user_id = new.id
       and (p.display_name = ''
            or pg_catalog.lower(p.display_name)
               = pg_catalog.lower(pg_catalog.left(pg_catalog.split_part(coalesce(new.email, ''), '@', 1), 60)));
  end if;
  return new;
end
$$;
revoke all on function private.handle_user_name_update() from public, anon, authenticated;

create trigger on_auth_user_name_updated
  after update of raw_user_meta_data on auth.users
  for each row execute function private.handle_user_name_update();
