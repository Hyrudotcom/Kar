-- Round 4 review fixes (server side).
--  * household_merges: accept_invite records "the user's solo household was merged into the new
--    one". get_my_household returns these ids as merged_from, so another phone of the user can tell
--    a switch (its outbox follows to the new household) from a removal or a leave (its unsent edits
--    are shown as "Je bent geen lid meer", never posted into a different household).
--  * apply_mutations: a mutation replayed after a household switch keeps its real outcome: a
--    rejection stays rejected, an add that accept_invite merged into another row reports 'merged'
--    with that row's id (an undo takes back only its own quantity).

create table private.household_merges (
  user_id        uuid not null references auth.users(id) on delete cascade,
  from_household uuid not null,
  to_household   uuid not null,
  at             timestamptz not null default now(),
  primary key (user_id, from_household)
);
create index household_merges_to on private.household_merges(user_id, to_household);
revoke all on private.household_merges from public, anon, authenticated;

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
  v_target    uuid;
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
      elsif v_prev.result ->> 'status' = 'rejected' then
        -- Rejected in the household this user left: still rejected (it appears in "kon niet worden
        -- opgeslagen" instead of silently turning into a success).
        v_res := v_prev.result || '{"replayed": true}'::jsonb;
      else
        -- Applied in the household this user left; accept_invite already moved/merged its effect
        -- into this household. The old result (item id, server_seq) belongs to the other household
        -- and must never reach the client. An add reports where its row lives now: 'merged' into
        -- another row (an undo then only takes its quantity back), or no item id when it is gone.
        v_target := null;
        if v_prev.kind = 'add_item' and pg_catalog.jsonb_typeof(v_m -> 'payload' -> 'id') = 'string' then
          begin
            v_target := private.resolve_item(v_household, (v_m -> 'payload' ->> 'id')::uuid);
          exception when invalid_text_representation then
            v_target := null;
          end;
          if not exists (select 1 from public.list_items i where i.id = v_target and i.household_id = v_household) then
            v_target := null;
          end if;
        end if;
        if v_target is null then
          v_res := pg_catalog.jsonb_build_object('id', v_mid, 'status',
                     case when v_prev.kind = 'add_item' then 'applied' else v_prev.result ->> 'status' end, 'replayed', true);
        else
          v_res := pg_catalog.jsonb_build_object('id', v_mid, 'replayed', true, 'item_id', v_target, 'status',
                     case when v_target <> (v_m -> 'payload' ->> 'id')::uuid then 'merged' else v_prev.result ->> 'status' end);
        end if;
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

create or replace function public.accept_invite(p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_chk     record;
  v_target  uuid;
  v_cur     uuid;
  v_cur2    uuid;
  v_inv     public.invites;
  v_lock    uuid;
  v_moved   int := 0;
  v_left    uuid;
  v_deleted uuid;
  r         public.list_items;
  v_dup     uuid;
  v_seq     bigint;
begin
  if v_uid is null then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_chk from private.check_invite(v_uid, p_code);
  if v_chk.error is not null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', v_chk.error);
  end if;
  v_target := (v_chk.invite).household_id;

  select m.household_id into v_cur from public.household_members m where m.user_id = v_uid;

  -- Lock both households in id order.
  for v_lock in select x from pg_catalog.unnest(array[v_cur, v_target]) x where x is not null order by x loop
    perform 1 from public.households h where h.id = v_lock for update;
  end loop;

  -- Re-validate under the locks.
  select * into v_inv from public.invites i where i.id = (v_chk.invite).id;
  if not found or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'expired_code');
  end if;
  select m.household_id into v_cur2 from public.household_members m where m.user_id = v_uid;
  if v_cur2 = v_target then
    -- e.g. a concurrent accept of the same user won the race
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'already_member');
  end if;
  if v_cur2 is distinct from v_cur then
    raise exception 'membership changed concurrently, retry';  -- transient: client retries
  end if;

  if v_cur is not null then
    if not exists (select 1 from public.household_members m where m.household_id = v_cur and m.user_id <> v_uid) then
      -- Alone: open items move along (deduped), oldest first so the newest ends on top.
      for r in select * from public.list_items i
                where i.household_id = v_cur and i.deleted_at is null and not i.checked
                order by i.position, i.id loop
        v_seq := private.next_seq(v_target);
        select i.id into v_dup from public.list_items i
         where i.household_id = v_target and i.normalized_name = r.normalized_name and i.unit = r.unit
           and i.deleted_at is null and not i.checked
         order by i.position desc, i.id limit 1;
        if found then
          update public.list_items
             set quantity = least(quantity + r.quantity, 99999), updated_at = now(), updated_by = v_uid,
                 server_seq = v_seq
           where id = v_dup;
          update private.item_aliases a set target_id = v_dup, household_id = v_target where a.target_id = r.id;
          insert into private.item_aliases (alias_id, household_id, target_id) values (r.id, v_target, v_dup);
        else
          update public.list_items
             set household_id = v_target, position = v_seq, server_seq = v_seq, updated_at = now(), updated_by = v_uid
           where id = r.id;
          update private.item_aliases a set household_id = v_target where a.target_id = r.id;
        end if;
        v_moved := v_moved + 1;
      end loop;
      -- Remembered so the user's other phones follow (re-address their outbox) instead of
      -- treating the switch as a removal; earlier merges into v_cur now lead to v_target too.
      update private.household_merges hm set to_household = v_target where hm.user_id = v_uid and hm.to_household = v_cur;
      insert into private.household_merges (user_id, from_household, to_household)
      values (v_uid, v_cur, v_target)
      on conflict (user_id, from_household) do update set to_household = excluded.to_household, at = now();
      perform pg_catalog.set_config('gb.membership_reason', 'household_deleted', true);
      delete from public.households h where h.id = v_cur;
      v_deleted := v_cur;
    else
      perform private.leave_internal(v_cur, v_uid, 'left');
      v_left := v_cur;
    end if;
  end if;

  insert into public.household_members (household_id, user_id, role) values (v_target, v_uid, 'member');

  return pg_catalog.jsonb_build_object('ok', true, 'household_id', v_target, 'moved_items', v_moved,
                                       'left_household_id', v_left, 'deleted_household_id', v_deleted);
end
$$;

create or replace function public.get_my_household() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_m   public.household_members;
begin
  if v_uid is null then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_m from public.household_members m where m.user_id = v_uid;
  if not found then
    return pg_catalog.jsonb_build_object('ok', true, 'household', null, 'role', null, 'members', '[]'::jsonb,
                                         'merged_from', '[]'::jsonb);
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'household', private.household_json(v_m.household_id),
    'role', v_m.role,
    'merged_from', (select coalesce(pg_catalog.jsonb_agg(hm.from_household order by hm.at), '[]'::jsonb)
                      from private.household_merges hm
                     where hm.user_id = v_uid and hm.to_household = v_m.household_id),
    'members', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'household_id', m.household_id, 'user_id', m.user_id, 'role', m.role,
                    'joined_at', m.joined_at, 'display_name', coalesce(p.display_name, ''))
                  order by m.joined_at, m.user_id), '[]'::jsonb)
                  from public.household_members m
                  left join public.profiles p on p.user_id = m.user_id
                 where m.household_id = v_m.household_id));
end
$$;

revoke all on function public.apply_mutations(jsonb) from public, anon;
grant execute on function public.apply_mutations(jsonb) to authenticated;
revoke all on function public.accept_invite(text) from public, anon;
grant execute on function public.accept_invite(text) to authenticated;
revoke all on function public.get_my_household() from public, anon;
grant execute on function public.get_my_household() to authenticated;
