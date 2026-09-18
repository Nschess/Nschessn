-- Friendly Challenge notification lifecycle and targeted-create idempotency.
--
-- This is deliberately forward-only. It leaves the Phase 4 multiplayer
-- authority path unchanged and hardens only friend-targeted pending invites.

begin;

alter table public.game_challenges
  add column if not exists request_fingerprint text;

-- Older rows have no request fingerprint and are intentionally excluded. New
-- targeted pending invitations are unique only for the same caller, target,
-- and normalized requested configuration; different configurations and all
-- terminal rows remain valid independent challenges.
create unique index if not exists game_challenges_pending_target_fingerprint_key
  on public.game_challenges (creator_id, opponent_id, request_fingerprint)
  where status = 'pending'
    and opponent_id is not null
    and request_fingerprint is not null;

create or replace function public.create_game_challenge(
  p_target_id uuid,
  p_code text,
  p_invite_type text,
  p_game_type text,
  p_color text,
  p_clock text
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  created public.game_challenges;
  normalized_invite_type text := case when p_invite_type = 'public' then 'public' else 'private' end;
  normalized_game_type text := case when p_game_type = 'rated' then 'rated' else 'casual' end;
  requested_color text := case when p_color in ('w', 'b') then p_color else 'random' end;
  creator_color text;
  clock_value text := case when p_clock = 'none' or p_clock ~ '^[0-9]{1,3}[+][0-9]{1,3}$' then p_clock else '10+0' end;
  requested_fingerprint text;
  base_ms bigint;
  increment_value integer;
begin
  if current_user_id is null then raise exception 'Sign in to create a challenge'; end if;
  if p_code !~ '^[A-Z2-9]{8,16}$' then raise exception 'Challenge code is invalid'; end if;
  if p_target_id = current_user_id then raise exception 'Choose another registered player'; end if;
  if p_target_id is not null and not exists (select 1 from public.profiles where id = p_target_id and not coalesce(is_bot, false)) then
    raise exception 'That player is unavailable';
  end if;

  -- An expired pending invitation is terminal, not an idempotency match. The
  -- existing lifecycle routine also emits the corresponding resolution event.
  perform public.expire_game_challenges();

  if p_target_id is not null then
    requested_fingerprint := format(
      'v1|%s|%s|%s|%s',
      normalized_invite_type,
      normalized_game_type,
      requested_color,
      clock_value
    );

    -- Serialize a challenger/target pair before probing or inserting. The
    -- unique partial index remains the durable database invariant; this lock
    -- makes both concurrent RPC calls return the same pending invitation.
    perform pg_advisory_xact_lock(hashtextextended(
      format('nschess:friend-challenge:%s:%s', current_user_id, p_target_id),
      0
    ));

    select * into created
    from public.game_challenges as challenge
    where challenge.creator_id = current_user_id
      and challenge.opponent_id = p_target_id
      and challenge.status = 'pending'
      and challenge.request_fingerprint = requested_fingerprint
    order by challenge.created_at asc
    limit 1
    for update;

    if created.id is not null then
      return public.challenge_payload(created);
    end if;
  end if;

  creator_color := case
    when requested_color = 'b' then 'b'
    when requested_color = 'w' then 'w'
    when random() < .5 then 'w'
    else 'b'
  end;
  base_ms := case when clock_value = 'none' then 0 else least(1440, greatest(0, split_part(clock_value, '+', 1)::integer)) * 60000 end;
  increment_value := case when clock_value = 'none' then 0 else least(120, greatest(0, split_part(clock_value, '+', 2)::integer)) * 1000 end;

  insert into public.game_challenges (
    code, creator_id, opponent_id, invite_type, game_type, creator_color,
    clock, expires_at, request_fingerprint
  ) values (
    p_code, current_user_id, p_target_id, normalized_invite_type,
    normalized_game_type, creator_color, clock_value, now() + interval '24 hours',
    requested_fingerprint
  )
  returning * into created;

  update public.game_challenges
  set white_ms = base_ms, black_ms = base_ms, increment_ms = increment_value,
      active_color = 'w', turn_started_at = null
  where id = created.id
  returning * into created;

  return public.challenge_payload(created);
end;
$$;

create or replace function public.notify_game_challenge_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.opponent_id is not null then
    perform public.create_social_notification(new.opponent_id, new.creator_id, 'challenge_received', new.id, new.code, '{}'::jsonb);
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'active' and new.opponent_id is not null then
    -- Targeted invitations already have opponent_id before acceptance. The
    -- authoritative pending-to-active transition is the acceptance event.
    perform public.create_social_notification(new.creator_id, new.opponent_id, 'challenge_accepted', new.id, new.code, '{}'::jsonb);
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'declined' then
    perform public.create_social_notification(new.creator_id, new.opponent_id, 'challenge_declined', new.id, new.code, '{}'::jsonb);
  end if;

  -- The received-invitation notification is actionable only while the
  -- challenge is pending. Preserve its row for history but remove it from
  -- active notification queries/counts as soon as the invite resolves.
  if tg_op = 'UPDATE'
    and old.status in ('pending', 'accepted')
    and new.status in ('active', 'declined', 'cancelled', 'expired')
    and new.opponent_id is not null then
    update public.social_notifications
    set read_at = coalesce(read_at, now()),
        expires_at = least(expires_at, now())
    where recipient_id = new.opponent_id
      and type = 'challenge_received'
      and entity_id = new.id
      and expires_at > now();
  end if;

  return new;
end;
$$;

revoke all on function public.create_game_challenge(uuid, text, text, text, text, text) from public;
revoke all on function public.notify_game_challenge_change() from public;
grant execute on function public.create_game_challenge(uuid, text, text, text, text, text) to authenticated;

commit;
