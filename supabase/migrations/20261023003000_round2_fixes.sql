-- ---------------------------------------------------------------------------
-- Round 2: invite rate limits.
--  * A request turned away as rate_limited is no longer logged. Before, it counted towards every
--    limit: one account could fill the global ceiling (200 rows / 10 min) on its own and lock out
--    every invitation app-wide, and a user who kept retrying never got out of the per-account limit.
--    Now one account adds at most 10 rows per 10 minutes, so the global ceiling needs 20 accounts.
--  * The per-household block (20 failed lookups of a household's expired/revoked codes per hour) is
--    gone. A removed member knows old codes and could lock the household's CURRENT code with it,
--    also a freshly replaced one. Guessing unknown codes never hits it (they have no household), and
--    a stale code is already capped by the per-code, per-account and per-IP limits.
-- ---------------------------------------------------------------------------
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
