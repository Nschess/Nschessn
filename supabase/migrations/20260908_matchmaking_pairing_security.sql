-- Quick Match pairing security repair.
--
-- The game_challenges security trigger requires creator_id to be the
-- authenticated caller. The previous matcher selected the oldest queue ticket
-- as creator, which caused a newer caller's legitimate pair creation to fail
-- with "You cannot create this challenge". Pairing remains server-owned: the
-- caller is validated against its queue ticket and the opponent is selected by
-- the same compatibility predicate under the transaction lock.

create or replace function public.try_pair_matchmaking_queue(p_user_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  self_row public.matchmaking_queue;
  opponent_row public.matchmaking_queue;
  creator_row public.matchmaking_queue;
  opponent_user_row public.matchmaking_queue;
  rating_band integer;
  code_value text;
  creator_color text;
  base_ms bigint;
  increment_value integer;
  created public.game_challenges;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'Authenticated user does not match matchmaking queue owner';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('nschess:quick-match', 0));
  perform public.expire_matchmaking_queue();
  select * into self_row from public.matchmaking_queue where user_id = p_user_id for update;
  if self_row.id is null then return null; end if;
  if self_row.queue_state = 'ai_fallback' then
    return public.matchmaking_status_payload(self_row, 'ai_fallback');
  end if;
  if self_row.matched_code is not null or self_row.queue_state = 'matched' then
    return public.matchmaking_status_payload(self_row, 'matched', self_row.matched_code);
  end if;

  if exists (
    select 1 from public.game_challenges challenge
    where challenge.status = 'active'
      and p_user_id in (challenge.creator_id, challenge.opponent_id)
  ) then
    delete from public.matchmaking_queue where id = self_row.id;
    raise exception 'Finish or leave your active game before joining Quick Match';
  end if;

  rating_band := public.quick_match_rating_band(self_row.joined_at);
  select candidate.* into opponent_row
  from public.matchmaking_queue as candidate
  where candidate.user_id <> p_user_id
    and candidate.queue = self_row.queue
    and candidate.clock = self_row.clock
    and candidate.game_type = self_row.game_type
    and candidate.queue_state = 'searching'
    and candidate.matched_code is null
    and candidate.heartbeat_at >= now() - interval '45 seconds'
    and candidate.expires_at > now()
    and abs(candidate.rating - self_row.rating) <= rating_band
    and (self_row.region = 'global' or candidate.region = 'global' or candidate.region = self_row.region)
    and not exists (
      select 1 from public.game_challenges challenge
      where challenge.status = 'active'
        and candidate.user_id in (challenge.creator_id, challenge.opponent_id)
    )
  order by candidate.joined_at
  limit 1
  for update skip locked;
  if opponent_row.id is null then
    return public.matchmaking_status_payload(self_row, 'waiting');
  end if;

  -- The security trigger on game_challenges intentionally binds creator_id to
  -- auth.uid(). The caller is not necessarily the oldest ticket, so the
  -- authenticated queue owner must be the creator for this transaction.
  creator_row := self_row;
  opponent_user_row := opponent_row;
  creator_color := public.resolve_matchmaking_creator_color(creator_row.preferred_color, opponent_user_row.preferred_color);
  code_value := public.make_game_challenge_code();
  base_ms := case when creator_row.clock = 'none' then 0 else least(1440, greatest(0, split_part(creator_row.clock, '+', 1)::integer)) * 60000 end;
  increment_value := case when creator_row.clock = 'none' then 0 else least(120, greatest(0, split_part(creator_row.clock, '+', 2)::integer)) * 1000 end;
  insert into public.game_challenges (
    code, creator_id, opponent_id, invite_type, game_type, creator_color, clock,
    white_ms, black_ms, increment_ms, active_color, turn_started_at, status, expires_at, match_source
  ) values (
    code_value, creator_row.user_id, opponent_user_row.user_id, 'private', creator_row.game_type, creator_color, creator_row.clock,
    base_ms, base_ms, increment_value, 'w', case when creator_row.clock = 'none' then null else now() end,
    'active', now() + interval '24 hours', 'matchmaking'
  ) returning * into created;
  update public.matchmaking_queue
  set matched_code = created.code, matched_at = now(), queue_state = 'matched', heartbeat_at = now(), expires_at = now() + interval '15 minutes'
  where id in (self_row.id, opponent_row.id);
  select * into self_row from public.matchmaking_queue where id = self_row.id;
  return public.matchmaking_status_payload(self_row, 'matched', created.code);
end;
$$;

revoke all on function public.try_pair_matchmaking_queue(uuid) from public;
