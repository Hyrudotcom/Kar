-- Realtime nudges (docs/architecture.md 3.2). Clients treat every event as "pull now";
-- payloads are never applied as data. Postgres-changes are RLS-filtered, so only members get them.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

alter publication supabase_realtime add table public.list_items, public.households, public.household_members;

-- Membership loss cannot be delivered via postgres-changes (the removed user no longer passes RLS),
-- so every deleted membership row is announced on the private broadcast topic 'user:<uid>'.
-- payload: { household_id, reason } with reason removed | left | household_deleted | account_deleted.
-- A client that receives it for a household that is not its current one (e.g. after accept_invite
-- deleted its old solo household) simply re-checks get_my_household().
create function private.notify_membership_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform realtime.send(
      pg_catalog.jsonb_build_object(
        'household_id', old.household_id,
        'reason', coalesce(nullif(pg_catalog.current_setting('gb.membership_reason', true), ''), 'removed')),
      'membership_changed',
      'user:' || old.user_id::text,
      true);
  exception when others then
    -- Never block a membership change on realtime; the app also re-checks membership on open.
    raise warning 'membership_changed broadcast failed: % %', sqlstate, sqlerrm;
  end;
  return old;
end
$$;
revoke all on function private.notify_membership_deleted() from public, anon, authenticated;

create trigger household_members_notify_delete
  after delete on public.household_members
  for each row execute function private.notify_membership_deleted();

-- Private broadcast channel 'user:<uid>': only that user may listen (RLS is already on for realtime.messages).
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute $p$
      create policy gb_user_topic_read on realtime.messages
        for select to authenticated
        using (
          realtime.messages.extension = 'broadcast'
          and (select realtime.topic()) = 'user:' || (select auth.uid())::text
        )
    $p$;
  else
    raise notice 'realtime.messages missing: private membership broadcasts disabled';
  end if;
end
$$;
