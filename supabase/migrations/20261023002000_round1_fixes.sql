-- Round-1 review fixes (server side). See the commit message for the findings.

-- ---------------------------------------------------------------------------
-- apply_mutations: stop applying after the first 'retry' in a batch.
-- ---------------------------------------------------------------------------
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
      if v_prev.user_id = v_uid then
        v_res := v_prev.result || '{"replayed": true}'::jsonb;
      else
        v_res := pg_catalog.jsonb_build_object('id', v_mid, 'status', 'rejected', 'reason', 'invalid');
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

-- ---------------------------------------------------------------------------
-- Invite brute force. x-forwarded-for is set by the client (anyone can send a new value per
-- request), so it is not an IP. Only the edge proxy's cf-connecting-ip is trusted; without it the
-- per-IP limit is off and the per-account and global limits still apply.
-- ---------------------------------------------------------------------------
create or replace function private.request_ip() returns text
language plpgsql stable set search_path = '' as $$
declare v text;
begin
  v := pg_catalog.current_setting('request.headers', true)::json ->> 'cf-connecting-ip';
  return nullif(pg_catalog.btrim(v), '');
exception when others then
  return null;
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
     or (select count(*) from private.invite_attempts a
          where a.household_id is null and not a.success and a.at > now() - interval '10 minutes') >= 200 then
    perform private.log_attempt(p_uid, v_ip, v_code, null, false);
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

  if (select count(*) from private.invite_attempts a
       where a.household_id = invite.household_id and not a.success
         and a.at > now() - interval '1 hour') >= 20 then
    perform private.log_attempt(p_uid, v_ip, v_code, null, false);
    error := 'rate_limited';
    invite := null;
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

revoke all on function private.request_ip() from public, anon, authenticated;
revoke all on function private.check_invite(uuid, text) from public, anon, authenticated;
revoke all on function public.apply_mutations(jsonb) from public, anon;
grant execute on function public.apply_mutations(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: postgres-changes DELETE events are not filtered by RLS (the old row is sent to every
-- subscriber of the table), so a non-member could see who left which household. Deletes are never
-- needed as nudges: items are soft-deleted (an update) and membership loss has its own private
-- broadcast. So household_members leaves the publication and the publication sends no deletes.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime drop table public.household_members;
alter publication supabase_realtime set (publish = 'insert, update');

-- ---------------------------------------------------------------------------
-- Price observations: the latest usable observation per product and chain, computed in the
-- database (the raw table grows without bound and PostgREST returns at most 1000 rows per request).
-- Same rules as the engine: verified source, national/webshop channel, no loyalty-only price,
-- observed within 14 days (and not in the future), and only for products linked at that chain.
-- ---------------------------------------------------------------------------
-- The view takes the name of the old index (same namespace).
alter index public.price_observations_latest rename to price_observations_product_chain_observed;

create view public.price_observations_latest with (security_invoker = true) as
select distinct on (o.product_id, o.chain_id) o.*
  from public.price_observations o
  join public.price_sources s on s.id = o.source_id
 where s.verified_for_consumer_display
   and s.channel in ('national', 'webshop')
   and not o.requires_loyalty
   and o.observed_at is not null
   and o.observed_at > now() - interval '14 days'
   and o.observed_at <= now() + interval '5 minutes'
   and exists (select 1 from public.catalog_product_links l
                where l.product_id = o.product_id and l.chain_id = o.chain_id)
 order by o.product_id, o.chain_id, o.observed_at desc, o.ingested_at desc, o.id;

revoke all on public.price_observations_latest from public, anon;
grant select on public.price_observations_latest to authenticated;

-- ---------------------------------------------------------------------------
-- No passwords, ever. Sign-in is by e-mail code, Apple or Google. A password set by someone who
-- signed up with another person's address before that person did would otherwise keep working
-- after the real owner signs in with a code (pre-account takeover). GoTrue cannot turn the
-- password grant off, so the stored hash is blanked: every password check fails.
-- ---------------------------------------------------------------------------
create function private.strip_password() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.encrypted_password is not null and new.encrypted_password <> '' then
    new.encrypted_password := '';
  end if;
  return new;
end
$$;
revoke all on function private.strip_password() from public, anon, authenticated;

create trigger no_passwords
  before insert or update of encrypted_password on auth.users
  for each row execute function private.strip_password();

update auth.users set encrypted_password = '' where encrypted_password is not null and encrypted_password <> '';
