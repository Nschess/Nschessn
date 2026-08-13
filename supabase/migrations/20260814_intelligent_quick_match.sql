-- Intelligent Quick Match: server-owned queue state, human-first pairing,
-- heartbeat cleanup, and an explicit AI fallback decision.
-- This file is plain PostgreSQL for direct execution in the Supabase SQL Editor.
-- Additive migration; the existing four-argument RPC remains compatible.

alter table public.matchmaking_queue
  add column if not exists region text not null default 'global',
  add column if not exists queue_state text not null default 'searching',
  add column if not exists heartbeat_at timestamptz not null default now();

update public.matchmaking_queue
set queue_state = case
  when matched_code is not null then 'matched'
  else 'searching'
end
where queue_state is null
   or queue_state not in ('searching', 'matched', 'ai_fallback', 'cancelled', 'expired')
   or matched_code is not null;

alter table public.matchmaking_queue
  drop constraint if exists matchmaking_queue_state_check,
  add constraint matchmaking_queue_state_check
    check (queue_state in ('searching', 'matched', 'ai_fallback', 'cancelled', 'expired')),
  drop constraint if exists matchmaking_queue_region_check,
  add constraint matchmaking_queue_region_check
    check (char_length(region) between 1 and 32);

create index if not exists matchmaking_queue_search_idx
  on public.matchmaking_queue (queue_state, queue, clock, game_type, rating, joined_at)
  where queue_state = 'searching';

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'matchmaking_queue'
  ) then
    alter publication supabase_realtime add table public.matchmaking_queue;
  end if;
exception when undefined_object then
  -- Local SQL installs may not have Supabase Realtime; production does.
  null;
end
$$;

create or replace function public.quick_match_fallback_seconds(p_game_type text)
returns integer
language sql
immutable
as $$
  select case when p_game_type = 'rated' then 25 else 12 end;
$$;

create or replace function public.quick_match_rating_band(p_joined_at timestamptz)
returns integer
language sql
stable
as $$
  select least(300, 100 + floor(greatest(0, extract(epoch from now() - p_joined_at)) / 5)::integer * 100);
$$;

create or replace function public.expire_matchmaking_queue()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  delete from public.matchmaking_queue
  where (queue_state = 'searching' and (expires_at < now() or heartbeat_at < now() - interval '45 seconds'))
     or (queue_state in ('matched', 'ai_fallback') and matched_at < now() - interval '15 minutes');
end;
$$;

create or replace function public.matchmaking_status_payload(
  p_ticket public.matchmaking_queue,
  p_status text,
  p_challenge_code text default null
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'status', p_status,
    'queueState', p_ticket.queue_state,
    'ticketId', p_ticket.id,
    'queue', p_ticket.queue,
    'clock', p_ticket.clock,
    'gameType', p_ticket.game_type,
    'preferredColor', p_ticket.preferred_color,
    'region', p_ticket.region,
    'joinedAt', p_ticket.joined_at,
    'waitSeconds', greatest(0, floor(extract(epoch from now() - p_ticket.joined_at)))::integer,
    'estimatedWaitSeconds', public.quick_match_fallback_seconds(p_ticket.game_type),
    'fallbackSeconds', public.quick_match_fallback_seconds(p_ticket.game_type),
    'fallbackAt', p_ticket.joined_at + make_interval(secs => public.quick_match_fallback_seconds(p_ticket.game_type)),
    'ratingRange', public.quick_match_rating_band(p_ticket.joined_at),
    'challengeCode', p_challenge_code
  );
$$;

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

  if self_row.joined_at <= opponent_row.joined_at then
    creator_row := self_row; opponent_user_row := opponent_row;
  else
    creator_row := opponent_row; opponent_user_row := self_row;
  end if;
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

create or replace function public.join_matchmaking_queue(
  p_queue text default 'quick',
  p_clock text default '5+0',
  p_game_type text default 'casual',
  p_preferred_color text default 'random',
  p_region text default 'global'
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  ticket public.matchmaking_queue;
  player_rating integer := 450;
  paired jsonb;
begin
  if current_user_id is null then raise exception 'Sign in to use Quick Match'; end if;
  perform public.expire_matchmaking_queue();
  select rating into player_rating from public.profiles where id = current_user_id;
  player_rating := greatest(400, least(3000, coalesce(player_rating, 450)));
  insert into public.matchmaking_queue (user_id, queue, clock, game_type, preferred_color, rating, region, queue_state, joined_at, heartbeat_at, expires_at)
  values (
    current_user_id,
    'quick',
    case when p_clock = 'none' or p_clock ~ '^[0-9]{1,3}[+][0-9]{1,3}$' then p_clock else '5+0' end,
    case when p_game_type = 'rated' then 'rated' else 'casual' end,
    case when p_preferred_color in ('w', 'b', 'random') then p_preferred_color else 'random' end,
    player_rating,
    left(coalesce(nullif(trim(p_region), ''), 'global'), 32),
    'searching', now(), now(), now() + interval '10 minutes'
  ) on conflict (user_id) do update set
    queue = excluded.queue, clock = excluded.clock, game_type = excluded.game_type, preferred_color = excluded.preferred_color,
    rating = excluded.rating, region = excluded.region, queue_state = 'searching', joined_at = excluded.joined_at,
    heartbeat_at = now(), expires_at = excluded.expires_at, matched_code = null, matched_at = null
  returning * into ticket;
  paired := public.try_pair_matchmaking_queue(current_user_id);
  if paired is not null then return paired; end if;
  select * into ticket from public.matchmaking_queue where user_id = current_user_id;
  return public.matchmaking_status_payload(ticket, 'waiting');
end;
$$;

create or replace function public.join_matchmaking_queue(
  p_queue text default 'quick',
  p_clock text default '5+0',
  p_game_type text default 'casual',
  p_preferred_color text default 'random'
)
returns jsonb
language sql
security definer set search_path = public
as $$
  select public.join_matchmaking_queue(p_queue, p_clock, p_game_type, p_preferred_color, 'global');
$$;

create or replace function public.resolve_matchmaking_timeout(p_ticket_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  ticket public.matchmaking_queue;
  paired jsonb;
  fallback_seconds integer;
begin
  if current_user_id is null then raise exception 'Sign in to use Quick Match'; end if;
  perform public.expire_matchmaking_queue();
  select * into ticket from public.matchmaking_queue where id = p_ticket_id and user_id = current_user_id for update;
  if ticket.id is null then return jsonb_build_object('status', 'expired', 'ticketId', p_ticket_id); end if;
  if ticket.matched_code is not null or ticket.queue_state = 'matched' then return public.matchmaking_status_payload(ticket, 'matched', ticket.matched_code); end if;
  if ticket.queue_state = 'ai_fallback' then return public.matchmaking_status_payload(ticket, 'ai_fallback'); end if;
  paired := public.try_pair_matchmaking_queue(current_user_id);
  if paired is not null and (paired->>'status') <> 'waiting' then return paired; end if;
  select * into ticket from public.matchmaking_queue where id = p_ticket_id and user_id = current_user_id for update;
  fallback_seconds := public.quick_match_fallback_seconds(ticket.game_type);
  if now() >= ticket.joined_at + make_interval(secs => fallback_seconds) then
    update public.matchmaking_queue set queue_state = 'ai_fallback', matched_at = now(), heartbeat_at = now(), expires_at = now() + interval '15 minutes'
    where id = ticket.id returning * into ticket;
    return public.matchmaking_status_payload(ticket, 'ai_fallback');
  end if;
  return public.matchmaking_status_payload(ticket, 'waiting');
end;
$$;

create or replace function public.get_matchmaking_status(p_ticket_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  ticket public.matchmaking_queue;
  paired jsonb;
begin
  if current_user_id is null then raise exception 'Sign in to use Quick Match'; end if;
  select * into ticket from public.matchmaking_queue where id = p_ticket_id and user_id = current_user_id;
  if ticket.id is null then return jsonb_build_object('status', 'expired', 'ticketId', p_ticket_id); end if;
  if ticket.matched_code is not null or ticket.queue_state = 'matched' then return public.matchmaking_status_payload(ticket, 'matched', ticket.matched_code); end if;
  if ticket.queue_state = 'ai_fallback' then return public.matchmaking_status_payload(ticket, 'ai_fallback'); end if;
  paired := public.try_pair_matchmaking_queue(current_user_id);
  if paired is not null then return paired; end if;
  select * into ticket from public.matchmaking_queue where id = p_ticket_id and user_id = current_user_id;
  return public.matchmaking_status_payload(ticket, 'waiting');
end;
$$;

create or replace function public.heartbeat_matchmaking_queue(p_ticket_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  ticket public.matchmaking_queue;
begin
  if current_user_id is null then raise exception 'Sign in to use Quick Match'; end if;
  update public.matchmaking_queue set heartbeat_at = now(), expires_at = greatest(expires_at, now() + interval '2 minutes')
  where id = p_ticket_id and user_id = current_user_id and queue_state = 'searching'
  returning * into ticket;
  if ticket.id is null then return jsonb_build_object('status', 'expired', 'ticketId', p_ticket_id); end if;
  return public.matchmaking_status_payload(ticket, 'waiting');
end;
$$;

create or replace function public.leave_matchmaking_queue(p_ticket_id uuid)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then raise exception 'Sign in to use Quick Match'; end if;
  delete from public.matchmaking_queue where id = p_ticket_id and user_id = current_user_id and queue_state in ('searching', 'matched', 'ai_fallback');
  return jsonb_build_object('status', 'left', 'ticketId', p_ticket_id);
end;
$$;

revoke all on function public.quick_match_fallback_seconds(text) from public;
revoke all on function public.quick_match_rating_band(timestamptz) from public;
revoke all on function public.resolve_matchmaking_timeout(uuid) from public;
revoke all on function public.heartbeat_matchmaking_queue(uuid) from public;
grant execute on function public.join_matchmaking_queue(text, text, text, text, text) to authenticated;
grant execute on function public.join_matchmaking_queue(text, text, text, text) to authenticated;
grant execute on function public.get_matchmaking_status(uuid) to authenticated;
grant execute on function public.resolve_matchmaking_timeout(uuid) to authenticated;
grant execute on function public.heartbeat_matchmaking_queue(uuid) to authenticated;
grant execute on function public.leave_matchmaking_queue(uuid) to authenticated;
