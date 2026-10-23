-- RPCs (owner: backend). Contract: src/contracts/mutations.ts and src/contracts/household.ts,
-- semantics: docs/architecture.md section 4.
--
-- Every function: security definer, search_path = '' (fully qualified names), auth.uid() check.
-- Expected failures are values ({ok:false,error}), never exceptions.
-- Lock order: households rows, always by ascending id when more than one is locked.

-- ===========================================================================
-- Internal helpers (schema private, never exposed through PostgREST)
-- ===========================================================================

-- Raised for payload validation failures; mapped to rejected/invalid.
create function private.invalid(p_msg text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  raise exception using errcode = 'GB001', message = 'invalid: ' || p_msg;
end
$$;

create function private.j_uuid(p jsonb, p_key text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  if p is null or pg_catalog.jsonb_typeof(p -> p_key) is distinct from 'string' then
    perform private.invalid(p_key || ' must be a uuid string');
  end if;
  return (p ->> p_key)::uuid;
end
$$;

-- Name: string, trimmed length 1..p_max.
create function private.j_name(p jsonb, p_key text, p_max int) returns text
language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  if pg_catalog.jsonb_typeof(p -> p_key) is distinct from 'string' then
    perform private.invalid(p_key || ' must be a string');
  end if;
  v := pg_catalog.btrim(p ->> p_key);
  if pg_catalog.char_length(v) < 1 or pg_catalog.char_length(v) > p_max then
    perform private.invalid(p_key || ' length');
  end if;
  return v;
end
$$;

create function private.j_note(p jsonb, p_key text) returns text
language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  if p -> p_key is null or pg_catalog.jsonb_typeof(p -> p_key) = 'null' then
    return '';
  end if;
  if pg_catalog.jsonb_typeof(p -> p_key) <> 'string' then
    perform private.invalid(p_key || ' must be a string');
  end if;
  v := pg_catalog.btrim(p ->> p_key);
  if pg_catalog.char_length(v) > 140 then
    perform private.invalid(p_key || ' too long');
  end if;
  return v;
end
$$;

-- Quantity: JSON number, rounded to 3 decimals, 0 < q <= 99999.
create function private.j_qty(p jsonb, p_key text) returns numeric
language plpgsql immutable set search_path = '' as $$
declare v numeric;
begin
  if pg_catalog.jsonb_typeof(p -> p_key) is distinct from 'number' then
    perform private.invalid(p_key || ' must be a number');
  end if;
  v := pg_catalog.round((p ->> p_key)::numeric, 3);
  if v <= 0 or v > 99999 then
    perform private.invalid(p_key || ' out of range');
  end if;
  return v;
end
$$;

create function private.j_unit(p jsonb, p_key text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if pg_catalog.jsonb_typeof(p -> p_key) is distinct from 'string'
     or (p ->> p_key) not in ('stuk', 'g', 'kg', 'ml', 'l') then
    perform private.invalid(p_key || ' must be a unit');
  end if;
  return p ->> p_key;
end
$$;

create function private.j_bool(p jsonb, p_key text) returns boolean
language plpgsql immutable set search_path = '' as $$
begin
  if pg_catalog.jsonb_typeof(p -> p_key) is distinct from 'boolean' then
    perform private.invalid(p_key || ' must be a boolean');
  end if;
  return (p -> p_key)::boolean;
end
$$;

-- Next server_seq of a household. Caller must hold the household row lock.
create function private.next_seq(p_household uuid) returns bigint
language sql volatile set search_path = '' as $$
  update public.households set last_seq = last_seq + 1 where id = p_household returning last_seq
$$;

-- Resolves an item id through the alias table (only aliases of this household).
create function private.resolve_item(p_household uuid, p_id uuid) returns uuid
language sql stable set search_path = '' as $$
  select coalesce(
    (select a.target_id from private.item_aliases a where a.alias_id = p_id and a.household_id = p_household),
    p_id)
$$;

create function private.household_json(p_household uuid) returns jsonb
language sql stable set search_path = '' as $$
  select pg_catalog.jsonb_build_object('id', h.id, 'name', h.name, 'created_at', h.created_at, 'last_seq', h.last_seq)
    from public.households h where h.id = p_household
$$;

create function private.rejected(p_reason text, p_item uuid) returns jsonb
language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('status', 'rejected', 'reason', p_reason, 'item_id', p_item))
$$;

create function private.ok_result(p_status text, p_item uuid, p_seq bigint) returns jsonb
language sql immutable set search_path = '' as $$
  select pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object('status', p_status, 'item_id', p_item, 'server_seq', p_seq))
$$;

-- ===========================================================================
-- Mutation kinds. Each runs inside the caller's subtransaction with the household row locked.
-- Return a result without `id`; raise GB001 / data / integrity errors for rejected/invalid.
-- ===========================================================================

create function private.m_add_item(p_household uuid, p_uid uuid, p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id    uuid    := private.j_uuid(p, 'id');
  v_name  text    := private.j_name(p, 'name', 120);
  v_qty   numeric := private.j_qty(p, 'quantity');
  v_unit  text    := private.j_unit(p, 'unit');
  v_note  text    := private.j_note(p, 'note');
  v_norm  text    := public.gb_normalize_name(v_name);
  v_other uuid;
  v_target uuid;
  v_seq   bigint;
begin
  -- (1) the id is already known: idempotent no-op, but never across households.
  select i.household_id into v_other from public.list_items i where i.id = v_id;
  if found then
    if v_other <> p_household then perform private.invalid('id in use'); end if;
    return private.ok_result('applied', v_id, null);
  end if;
  select a.household_id, a.target_id into v_other, v_target from private.item_aliases a where a.alias_id = v_id;
  if found then
    if v_other <> p_household then perform private.invalid('id in use'); end if;
    return private.ok_result('applied', v_target, null);
  end if;

  -- (2) open duplicate: add the quantity.
  select i.id into v_target from public.list_items i
   where i.household_id = p_household and i.normalized_name = v_norm and i.unit = v_unit
     and i.deleted_at is null and not i.checked
   order by i.position desc, i.id limit 1;
  if found then
    v_seq := private.next_seq(p_household);
    update public.list_items
       set quantity = quantity + v_qty, updated_at = now(), updated_by = p_uid, server_seq = v_seq
     where id = v_target;
    insert into private.item_aliases (alias_id, household_id, target_id) values (v_id, p_household, v_target);
    return private.ok_result('merged', v_target, v_seq);
  end if;

  -- (3) checked duplicate: put it back on the list with the typed quantity.
  select i.id into v_target from public.list_items i
   where i.household_id = p_household and i.normalized_name = v_norm and i.unit = v_unit
     and i.deleted_at is null and i.checked
   order by i.checked_at desc nulls last, i.position desc, i.id limit 1;
  if found then
    v_seq := private.next_seq(p_household);
    update public.list_items
       set checked = false, checked_at = null, quantity = v_qty, position = v_seq,
           note = case when v_note <> '' then v_note else note end,
           updated_at = now(), updated_by = p_uid, server_seq = v_seq
     where id = v_target;
    insert into private.item_aliases (alias_id, household_id, target_id) values (v_id, p_household, v_target);
    return private.ok_result('restored', v_target, v_seq);
  end if;

  -- (4) new row.
  v_seq := private.next_seq(p_household);
  insert into public.list_items (id, household_id, name, quantity, unit, note, position,
                                 created_by, updated_by, server_seq)
  values (v_id, p_household, v_name, v_qty, v_unit, v_note, v_seq, p_uid, p_uid, v_seq);
  return private.ok_result('applied', v_id, v_seq);
end
$$;

create function private.m_update_item(p_household uuid, p_uid uuid, p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id     uuid := private.resolve_item(p_household, private.j_uuid(p, 'item_id'));
  f        jsonb := p -> 'fields';
  v_key    text;
  r        public.list_items;
  v_name   text;
  v_qty    numeric;
  v_unit   text;
  v_note   text;
  v_excl   boolean;
  v_seq    bigint;
begin
  if pg_catalog.jsonb_typeof(f) is distinct from 'object' then perform private.invalid('fields'); end if;
  for v_key in select pg_catalog.jsonb_object_keys(f) loop
    if v_key not in ('name', 'quantity', 'unit', 'note', 'exclude_from_comparison') then
      perform private.invalid('unknown field ' || v_key);
    end if;
  end loop;

  select * into r from public.list_items i where i.id = v_id and i.household_id = p_household;
  if not found then return private.rejected('not_found', v_id); end if;

  v_name := case when f ? 'name' then private.j_name(f, 'name', 120) else r.name end;
  v_qty  := case when f ? 'quantity' then private.j_qty(f, 'quantity') else r.quantity end;
  v_unit := case when f ? 'unit' then private.j_unit(f, 'unit') else r.unit end;
  v_note := case when f ? 'note' then private.j_note(f, 'note') else r.note end;
  v_excl := case when f ? 'exclude_from_comparison' then private.j_bool(f, 'exclude_from_comparison')
                 else r.exclude_from_comparison end;

  if r.deleted_at is not null then return private.rejected('deleted', v_id); end if;

  if v_name = r.name and v_qty = r.quantity and v_unit = r.unit and v_note = r.note
     and v_excl = r.exclude_from_comparison then
    return private.ok_result('applied', v_id, null);
  end if;

  v_seq := private.next_seq(p_household);
  update public.list_items
     set name = v_name, quantity = v_qty, unit = v_unit, note = v_note, exclude_from_comparison = v_excl,
         updated_at = now(), updated_by = p_uid, server_seq = v_seq
   where id = v_id;
  return private.ok_result('applied', v_id, v_seq);
end
$$;

create function private.m_increment_quantity(p_household uuid, p_uid uuid, p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id    uuid := private.resolve_item(p_household, private.j_uuid(p, 'item_id'));
  v_delta numeric;
  r       public.list_items;
  v_new   numeric;
  v_seq   bigint;
begin
  if pg_catalog.jsonb_typeof(p -> 'delta') is distinct from 'number' then perform private.invalid('delta'); end if;
  v_delta := pg_catalog.round((p ->> 'delta')::numeric, 3);
  if pg_catalog.abs(v_delta) > 99999 then perform private.invalid('delta out of range'); end if;

  select * into r from public.list_items i where i.id = v_id and i.household_id = p_household;
  if not found then return private.rejected('not_found', v_id); end if;
  if r.deleted_at is not null then return private.rejected('deleted', v_id); end if;
  if v_delta = 0 then return private.ok_result('applied', v_id, null); end if;

  v_new := r.quantity + v_delta;
  if v_new <= 0 or v_new > 99999 then perform private.invalid('quantity out of range'); end if;

  v_seq := private.next_seq(p_household);
  update public.list_items
     set quantity = v_new, updated_at = now(), updated_by = p_uid, server_seq = v_seq
   where id = v_id;
  return private.ok_result('applied', v_id, v_seq);
end
$$;

create function private.m_set_checked(p_household uuid, p_uid uuid, p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id      uuid    := private.resolve_item(p_household, private.j_uuid(p, 'item_id'));
  v_checked boolean := private.j_bool(p, 'checked');
  r         public.list_items;
  v_seq     bigint;
begin
  select * into r from public.list_items i where i.id = v_id and i.household_id = p_household;
  if not found then return private.rejected('not_found', v_id); end if;
  if r.deleted_at is not null then return private.rejected('deleted', v_id); end if;
  if r.checked = v_checked then return private.ok_result('applied', v_id, null); end if;

  v_seq := private.next_seq(p_household);
  update public.list_items
     set checked = v_checked, checked_at = case when v_checked then now() end,
         updated_at = now(), updated_by = p_uid, server_seq = v_seq
   where id = v_id;
  return private.ok_result('applied', v_id, v_seq);
end
$$;

create function private.m_delete_item(p_household uuid, p_uid uuid, p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id  uuid := private.resolve_item(p_household, private.j_uuid(p, 'item_id'));
  r     public.list_items;
  v_seq bigint;
begin
  select * into r from public.list_items i where i.id = v_id and i.household_id = p_household;
  if not found then return private.rejected('not_found', v_id); end if;
  if r.deleted_at is not null then return private.ok_result('applied', v_id, null); end if;

  v_seq := private.next_seq(p_household);
  update public.list_items
     set deleted_at = now(), deleted_by = p_uid, updated_at = now(), updated_by = p_uid, server_seq = v_seq
   where id = v_id;
  return private.ok_result('applied', v_id, v_seq);
end
$$;

create function private.m_restore_item(p_household uuid, p_uid uuid, p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_id  uuid := private.resolve_item(p_household, private.j_uuid(p, 'item_id'));
  r     public.list_items;
  v_seq bigint;
begin
  select * into r from public.list_items i where i.id = v_id and i.household_id = p_household;
  if not found then return private.rejected('not_found', v_id); end if;
  if r.deleted_at is null then return private.ok_result('applied', v_id, null); end if;

  v_seq := private.next_seq(p_household);
  update public.list_items
     set deleted_at = null, deleted_by = null, updated_at = now(), updated_by = p_uid, server_seq = v_seq
   where id = v_id;
  return private.ok_result('applied', v_id, v_seq);
end
$$;

create function private.m_clear_checked(p_household uuid, p_uid uuid, p jsonb) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_ids      jsonb := p -> 'item_ids';
  v_elem     jsonb;
  v_resolved uuid[] := '{}';
  v_id       uuid;
  v_affected uuid[] := '{}';
  v_seq      bigint;
begin
  if pg_catalog.jsonb_typeof(v_ids) is distinct from 'array' or pg_catalog.jsonb_array_length(v_ids) > 1000 then
    perform private.invalid('item_ids');
  end if;
  for v_elem in select pg_catalog.jsonb_array_elements(v_ids) loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'string' then perform private.invalid('item_ids element'); end if;
    v_id := private.resolve_item(p_household, (v_elem #>> '{}')::uuid);
    if not v_id = any (v_resolved) then v_resolved := v_resolved || v_id; end if;
  end loop;

  for v_id in
    select i.id from public.list_items i
     where i.household_id = p_household and i.id = any (v_resolved) and i.checked and i.deleted_at is null
     order by i.position, i.id
  loop
    v_seq := private.next_seq(p_household);
    update public.list_items
       set deleted_at = now(), deleted_by = p_uid, updated_at = now(), updated_by = p_uid, server_seq = v_seq
     where id = v_id;
    v_affected := v_affected || v_id;
  end loop;

  return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'status', 'applied', 'affected_ids', pg_catalog.to_jsonb(v_affected), 'server_seq', v_seq));
end
$$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.shares_household(uuid) to authenticated;

-- ===========================================================================
-- apply_mutations(batch jsonb) -> ApplyMutationsResponse
-- ===========================================================================
create function public.apply_mutations(batch jsonb) returns jsonb
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
    if v_res ->> 'status' <> 'retry' then
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

-- ===========================================================================
-- pull_changes(p_household_id, p_since_seq, p_limit) -> PullChangesResponse
-- ===========================================================================
create function public.pull_changes(p_household_id uuid, p_since_seq bigint, p_limit int default 500)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_h     public.households;
  v_since bigint := greatest(coalesce(p_since_seq, 0), 0);
  v_limit int := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_items jsonb;
  v_count int;
  v_cursor bigint;
begin
  if v_uid is null then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not exists (select 1 from public.household_members m
                  where m.household_id = p_household_id and m.user_id = v_uid) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_member');
  end if;

  -- last_seq first: every row with server_seq <= last_seq is committed (writers hold the row lock).
  select * into v_h from public.households h where h.id = p_household_id;

  -- Cursor older than the tombstone purge horizon, or ahead of the server (foreign/corrupt cursor).
  if v_since > 0 and (v_since < v_h.purged_before_seq or v_since > v_h.last_seq) then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'household', private.household_json(p_household_id), 'items', '[]'::jsonb,
      'server_seq', 0, 'has_more', false, 'reset_required', true);
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x) - 'rn' order by x.server_seq), '[]'::jsonb),
         count(*)::int,
         max(x.server_seq)
    into v_items, v_count, v_cursor
    from (select i.*, row_number() over (order by i.server_seq) as rn
            from public.list_items i
           where i.household_id = p_household_id
             and i.server_seq > v_since and i.server_seq <= v_h.last_seq
             and (v_since > 0 or i.deleted_at is null)
           order by i.server_seq
           limit v_limit) x;

  -- has_more: is there anything after the last returned row within the snapshot window?
  if v_count = v_limit and exists (
       select 1 from public.list_items i
        where i.household_id = p_household_id and i.server_seq > v_cursor and i.server_seq <= v_h.last_seq
          and (v_since > 0 or i.deleted_at is null)) then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'household', private.household_json(p_household_id), 'items', v_items,
      'server_seq', v_cursor, 'has_more', true, 'reset_required', false);
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'household', private.household_json(p_household_id), 'items', v_items,
    'server_seq', v_h.last_seq, 'has_more', false, 'reset_required', false);
end
$$;

-- ===========================================================================
-- Household internals
-- ===========================================================================

-- Removes p_user from p_household (caller holds the household lock). Last member -> household
-- deleted. Owner leaving -> longest-standing member becomes owner.
create function private.leave_internal(p_household uuid, p_user uuid, p_reason text,
                                       out household_deleted boolean, out new_owner_id uuid)
language plpgsql set search_path = '' as $$
declare v_role text;
begin
  household_deleted := false;
  perform pg_catalog.set_config('gb.membership_reason', p_reason, true);
  delete from public.household_members m
   where m.household_id = p_household and m.user_id = p_user
  returning m.role into v_role;

  if not exists (select 1 from public.household_members m where m.household_id = p_household) then
    perform pg_catalog.set_config('gb.membership_reason', 'household_deleted', true);
    delete from public.households h where h.id = p_household;
    household_deleted := true;
    return;
  end if;

  if v_role = 'owner' then
    select m.user_id into new_owner_id from public.household_members m
     where m.household_id = p_household order by m.joined_at, m.user_id limit 1;
    update public.household_members m set role = 'owner'
     where m.household_id = p_household and m.user_id = new_owner_id;
  end if;
end
$$;

create function private.new_invite_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- 32 symbols: byte & 31 has no bias
  v_bytes bytea := extensions.gen_random_bytes(6);
  v_code text := '';
begin
  for i in 0..5 loop
    v_code := v_code || pg_catalog.substr(v_alphabet, (pg_catalog.get_byte(v_bytes, i) & 31) + 1, 1);
  end loop;
  return v_code;
end
$$;

create function private.request_ip() returns text
language plpgsql stable set search_path = '' as $$
declare v text;
begin
  v := pg_catalog.current_setting('request.headers', true)::json ->> 'x-forwarded-for';
  return nullif(pg_catalog.btrim(pg_catalog.split_part(v, ',', 1)), '');
exception when others then
  return null;
end
$$;

create function private.log_attempt(p_uid uuid, p_ip text, p_code text, p_household uuid, p_success boolean)
returns void
language sql volatile set search_path = '' as $$
  insert into private.invite_attempts (user_id, ip, code, household_id, success)
  values (p_uid, p_ip, pg_catalog.left(coalesce(p_code, ''), 32), p_household, p_success)
$$;

-- Shared by preview_invite and accept_invite: rate limits, lookup, state. Logs the attempt.
create function private.check_invite(p_uid uuid, p_code text, out error text, out invite public.invites)
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
          where a.code = v_code and not a.success and a.at > now() - interval '1 hour') >= 10 then
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

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.shares_household(uuid) to authenticated;

-- ===========================================================================
-- Household RPCs
-- ===========================================================================

create function public.get_my_household() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_m   public.household_members;
begin
  if v_uid is null then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_m from public.household_members m where m.user_id = v_uid;
  if not found then
    return pg_catalog.jsonb_build_object('ok', true, 'household', null, 'role', null, 'members', '[]'::jsonb);
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'household', private.household_json(v_m.household_id),
    'role', v_m.role,
    'members', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                    'household_id', m.household_id, 'user_id', m.user_id, 'role', m.role,
                    'joined_at', m.joined_at, 'display_name', coalesce(p.display_name, ''))
                  order by m.joined_at, m.user_id), '[]'::jsonb)
                  from public.household_members m
                  left join public.profiles p on p.user_id = m.user_id
                 where m.household_id = v_m.household_id));
end
$$;

create function public.create_household(p_name text default 'Thuis') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_hid  uuid;
  v_name text := pg_catalog.btrim(coalesce(p_name, 'Thuis'));
begin
  if v_uid is null then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  -- Serialize concurrent "ensure" calls of the same user (two devices, app retries).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('gb.create_household:' || v_uid::text, 0));

  select m.household_id into v_hid from public.household_members m where m.user_id = v_uid;
  if found then
    return pg_catalog.jsonb_build_object('ok', true, 'household', private.household_json(v_hid), 'created', false);
  end if;
  if pg_catalog.char_length(v_name) < 1 or pg_catalog.char_length(v_name) > 60 then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  insert into public.households (name) values (v_name) returning id into v_hid;
  insert into public.household_members (household_id, user_id, role) values (v_hid, v_uid, 'owner');
  return pg_catalog.jsonb_build_object('ok', true, 'household', private.household_json(v_hid), 'created', true);
end
$$;

create function public.create_invite(p_household_id uuid, p_replace boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_inv  public.invites;
  v_try  int := 0;
begin
  if v_uid is null then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  perform 1 from public.households h where h.id = p_household_id for update;
  select m.role into v_role from public.household_members m
   where m.household_id = p_household_id and m.user_id = v_uid;
  if not found then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_member'); end if;
  if coalesce(p_replace, false) and v_role <> 'owner' then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_owner');
  end if;

  select * into v_inv from public.invites i where i.household_id = p_household_id and i.revoked_at is null;
  if found and not coalesce(p_replace, false) and v_inv.expires_at > now() then
    return pg_catalog.jsonb_build_object('ok', true, 'code', v_inv.code, 'expires_at', v_inv.expires_at,
                                         'url', 'https://goedboodschap.nl/j/' || v_inv.code);
  end if;
  update public.invites i set revoked_at = now() where i.household_id = p_household_id and i.revoked_at is null;

  loop
    v_try := v_try + 1;
    begin
      insert into public.invites (household_id, code, created_by, expires_at)
      values (p_household_id, private.new_invite_code(), v_uid, now() + interval '7 days')
      returning * into v_inv;
      exit;
    exception when unique_violation then
      if v_try >= 10 then raise; end if;   -- 1e9 codes: practically unreachable
    end;
  end loop;

  return pg_catalog.jsonb_build_object('ok', true, 'code', v_inv.code, 'expires_at', v_inv.expires_at,
                                       'url', 'https://goedboodschap.nl/j/' || v_inv.code);
end
$$;

create function public.preview_invite(p_code text) returns jsonb
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
        (select nullif(p.display_name, '') from public.profiles p
          join public.household_members m on m.user_id = p.user_id and m.household_id = (v_chk.invite).household_id
         where p.user_id = (v_chk.invite).created_by),
        (select p.display_name from public.profiles p
          join public.household_members m on m.user_id = p.user_id
         where m.household_id = (v_chk.invite).household_id and m.role = 'owner'),
        ''),
    'member_count', (select count(*) from public.household_members m
                      where m.household_id = (v_chk.invite).household_id),
    'leaves_current_household', v_others > 0,
    'current_household_name', (select h.name from public.households h where h.id = v_cur));
end
$$;

create function public.accept_invite(p_code text) returns jsonb
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

create function public.leave_household(p_household_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_res record;
begin
  if v_uid is null then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  perform 1 from public.households h where h.id = p_household_id for update;
  if not exists (select 1 from public.household_members m
                  where m.household_id = p_household_id and m.user_id = v_uid) then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  select * into v_res from private.leave_internal(p_household_id, v_uid, 'left');
  return pg_catalog.jsonb_build_object('ok', true, 'household_deleted', v_res.household_deleted,
                                       'new_owner_id', v_res.new_owner_id);
end
$$;

create function public.remove_member(p_household_id uuid, p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_role    text;
  v_revoked boolean;
begin
  if v_uid is null then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  perform 1 from public.households h where h.id = p_household_id for update;
  select m.role into v_role from public.household_members m
   where m.household_id = p_household_id and m.user_id = v_uid;
  if not found then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_member'); end if;
  if v_role <> 'owner' then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  if p_user_id = v_uid then return pg_catalog.jsonb_build_object('ok', false, 'error', 'cannot_remove_self'); end if;

  perform pg_catalog.set_config('gb.membership_reason', 'removed', true);
  delete from public.household_members m where m.household_id = p_household_id and m.user_id = p_user_id;
  if not found then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_member'); end if;

  -- Always rotate: the removed member's link/code must stop working. The next "Deel lijst" creates a new code.
  update public.invites i set revoked_at = now() where i.household_id = p_household_id and i.revoked_at is null;
  v_revoked := found;
  return pg_catalog.jsonb_build_object('ok', true, 'invite_revoked', v_revoked);
end
$$;

create function public.rename_household(p_household_id uuid, p_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_name text := pg_catalog.btrim(coalesce(p_name, ''));
begin
  if v_uid is null then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  perform 1 from public.households h where h.id = p_household_id for update;
  select m.role into v_role from public.household_members m
   where m.household_id = p_household_id and m.user_id = v_uid;
  if not found then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_member'); end if;
  if v_role <> 'owner' then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_owner'); end if;
  if pg_catalog.char_length(v_name) < 1 or pg_catalog.char_length(v_name) > 60 then
    return pg_catalog.jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  update public.households h set name = v_name where h.id = p_household_id;
  return pg_catalog.jsonb_build_object('ok', true, 'household', private.household_json(p_household_id));
end
$$;

create function public.delete_account() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_hid     uuid;
  v_deleted boolean := false;
begin
  if v_uid is null then return pg_catalog.jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select m.household_id into v_hid from public.household_members m where m.user_id = v_uid;
  if v_hid is not null then
    perform 1 from public.households h where h.id = v_hid for update;
    select household_deleted into v_deleted from private.leave_internal(v_hid, v_uid, 'account_deleted');
  end if;
  delete from private.mutations pm where pm.user_id = v_uid;
  delete from private.invite_attempts a where a.user_id = v_uid;
  delete from auth.users u where u.id = v_uid;   -- cascades profile, identities, sessions
  return pg_catalog.jsonb_build_object('ok', true, 'household_deleted', coalesce(v_deleted, false));
end
$$;

-- ===========================================================================
-- Maintenance: tombstones 30 d, mutation log 90 d, invite attempts 2 d.
-- purged_before_seq = highest purged server_seq; a cursor below it must reset.
-- ===========================================================================
create function private.purge(p_tombstones interval default interval '30 days',
                              p_mutations interval default interval '90 days',
                              p_attempts interval default interval '2 days')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_h     uuid;
  v_max   bigint;
  v_items int := 0;
  v_n     int;
  v_muts  int;
  v_att   int;
begin
  for v_h in select distinct i.household_id from public.list_items i
              where i.deleted_at is not null and i.deleted_at < now() - p_tombstones
              order by 1 loop
    perform 1 from public.households h where h.id = v_h for update;
    with d as (
      delete from public.list_items i
       where i.household_id = v_h and i.deleted_at is not null and i.deleted_at < now() - p_tombstones
      returning i.server_seq)
    select max(server_seq), count(*) into v_max, v_n from d;
    if v_max is not null then
      update public.households h set purged_before_seq = greatest(h.purged_before_seq, v_max) where h.id = v_h;
      v_items := v_items + v_n;
    end if;
  end loop;
  delete from private.mutations pm where pm.received_at < now() - p_mutations;
  get diagnostics v_muts = row_count;
  delete from private.invite_attempts a where a.at < now() - p_attempts;
  get diagnostics v_att = row_count;
  return pg_catalog.jsonb_build_object('tombstones', v_items, 'mutations', v_muts, 'invite_attempts', v_att);
end
$$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.shares_household(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then
    perform cron.schedule('gb-purge', '17 3 * * *', 'select private.purge()');
  else
    raise notice 'pg_cron not installed: enable it, then run select cron.schedule(''gb-purge'', ''17 3 * * *'', ''select private.purge()'')';
  end if;
end
$$;

-- ===========================================================================
-- Grants: RPCs only for signed-in users.
-- ===========================================================================
revoke all on function public.apply_mutations(jsonb) from public, anon;
revoke all on function public.pull_changes(uuid, bigint, int) from public, anon;
revoke all on function public.get_my_household() from public, anon;
revoke all on function public.create_household(text) from public, anon;
revoke all on function public.create_invite(uuid, boolean) from public, anon;
revoke all on function public.preview_invite(text) from public, anon;
revoke all on function public.accept_invite(text) from public, anon;
revoke all on function public.leave_household(uuid) from public, anon;
revoke all on function public.remove_member(uuid, uuid) from public, anon;
revoke all on function public.rename_household(uuid, text) from public, anon;
revoke all on function public.delete_account() from public, anon;

grant execute on function public.apply_mutations(jsonb) to authenticated;
grant execute on function public.pull_changes(uuid, bigint, int) to authenticated;
grant execute on function public.get_my_household() to authenticated;
grant execute on function public.create_household(text) to authenticated;
grant execute on function public.create_invite(uuid, boolean) to authenticated;
grant execute on function public.preview_invite(text) to authenticated;
grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.leave_household(uuid) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.rename_household(uuid, text) to authenticated;
grant execute on function public.delete_account() to authenticated;
