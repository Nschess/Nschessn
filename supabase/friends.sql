-- Run after supabase/auth.sql in the Supabase SQL editor.
-- Friend relationships live here; profile.friends remains a legacy local-progress snapshot.
create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sender_id, receiver_id),
  check (sender_id <> receiver_id)
);

create index if not exists friend_requests_sender_status_idx on public.friend_requests (sender_id, status);
create index if not exists friend_requests_receiver_status_idx on public.friend_requests (receiver_id, status);

alter table public.friend_requests enable row level security;
grant select on public.friend_requests to authenticated;

drop policy if exists "friend request participants read" on public.friend_requests;
create policy "friend request participants read" on public.friend_requests
  for select to authenticated using (auth.uid() = sender_id or auth.uid() = receiver_id);

create or replace function public.send_friend_request(target_user uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  request_id uuid;
  existing_status text;
begin
  if current_user_id is null then raise exception 'Sign in to add friends'; end if;
  if target_user is null or target_user = current_user_id then raise exception 'Choose another registered player'; end if;
  if not exists (select 1 from public.profiles where id = target_user) then raise exception 'That player is unavailable'; end if;

  select id, status into request_id, existing_status
  from public.friend_requests
  where (sender_id = current_user_id and receiver_id = target_user)
     or (sender_id = target_user and receiver_id = current_user_id)
  order by created_at desc
  limit 1;

  if request_id is not null and existing_status = 'accepted' then
    raise exception 'You are already friends';
  end if;

  if request_id is not null and exists (
    select 1 from public.friend_requests
    where id = request_id and sender_id = target_user and receiver_id = current_user_id and status = 'pending'
  ) then
    update public.friend_requests set status = 'accepted', updated_at = now() where id = request_id;
    return request_id;
  end if;

  if request_id is not null and exists (
    select 1 from public.friend_requests
    where id = request_id and sender_id = current_user_id and receiver_id = target_user
  ) then
    update public.friend_requests set status = 'pending', updated_at = now() where id = request_id;
    return request_id;
  end if;

  insert into public.friend_requests (sender_id, receiver_id)
  values (current_user_id, target_user)
  returning id into request_id;
  return request_id;
end;
$$;

create or replace function public.respond_to_friend_request(request_id uuid, accept_request boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.friend_requests
  set status = case when accept_request then 'accepted' else 'declined' end,
      updated_at = now()
  where id = request_id and receiver_id = auth.uid() and status = 'pending';
  if not found then raise exception 'That request is no longer waiting for you'; end if;
end;
$$;

create or replace function public.cancel_friend_request(request_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  delete from public.friend_requests
  where id = request_id and sender_id = auth.uid() and status = 'pending';
  if not found then raise exception 'That request cannot be cancelled'; end if;
end;
$$;

create or replace function public.remove_friend(target_user uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  delete from public.friend_requests
  where status = 'accepted'
    and ((sender_id = auth.uid() and receiver_id = target_user)
      or (sender_id = target_user and receiver_id = auth.uid()));
  if not found then raise exception 'That friendship no longer exists'; end if;
end;
$$;

create or replace function public.get_friend_directory()
returns table (
  request_id uuid,
  public_id uuid,
  username text,
  avatar text,
  rating integer,
  title text,
  last_login_at timestamptz,
  request_status text,
  request_direction text
)
language sql
security definer set search_path = public
stable
as $$
  select
    request.id,
    profile.id,
    profile.username,
    profile.avatar,
    profile.rating,
    profile.title,
    profile.last_login_at,
    request.status,
    case when request.sender_id = auth.uid() then 'outgoing' else 'incoming' end
  from public.friend_requests as request
  join public.profiles as profile
    on profile.id = case when request.sender_id = auth.uid() then request.receiver_id else request.sender_id end
  where auth.uid() is not null
    and (request.sender_id = auth.uid() or request.receiver_id = auth.uid())
    and request.status in ('pending', 'accepted')
  order by request.updated_at desc;
$$;

revoke all on function public.send_friend_request(uuid) from public;
revoke all on function public.respond_to_friend_request(uuid, boolean) from public;
revoke all on function public.cancel_friend_request(uuid) from public;
revoke all on function public.remove_friend(uuid) from public;
revoke all on function public.get_friend_directory() from public;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.respond_to_friend_request(uuid, boolean) to authenticated;
grant execute on function public.cancel_friend_request(uuid) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.get_friend_directory() to authenticated;

-- Registered-player search and private friend games. Run this extension after the
-- friend-request section above. All writes go through security-definer RPCs.
alter table public.profiles add column if not exists is_bot boolean not null default false;

create extension if not exists pg_trgm;
create index if not exists profiles_username_search_idx
  on public.profiles using gin (username gin_trgm_ops)
  where not is_bot;

drop function if exists public.search_registered_players(text);
create function public.search_registered_players(p_query text)
returns table (
  public_id uuid,
  username text,
  avatar text,
  country_flag text,
  rating integer,
  title text,
  last_login_at timestamptz
)
language sql
security definer set search_path = public
stable
as $$
  select profile.id, profile.username, profile.avatar, coalesce(to_jsonb(profile) ->> 'country_flag', ''), profile.rating, profile.title, profile.last_login_at
  from public.profiles as profile
  where auth.uid() is not null
    and profile.id <> auth.uid()
    and not coalesce(profile.is_bot, false)
    and profile.username ilike '%' || left(trim(coalesce(p_query, '')), 20) || '%'
  order by profile.last_login_at desc nulls last, profile.username
  limit 8;
$$;

create table if not exists public.game_challenges (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{8,16}$'),
  creator_id uuid not null references auth.users(id) on delete cascade,
  opponent_id uuid references auth.users(id) on delete set null,
  invite_type text not null default 'private' check (invite_type in ('private', 'public')),
  game_type text not null default 'casual' check (game_type in ('casual', 'rated')),
  creator_color text not null check (creator_color in ('w', 'b')),
  clock text not null default '10+0' check (length(clock) <= 24),
  white_ms bigint not null default 600000 check (white_ms >= 0),
  black_ms bigint not null default 600000 check (black_ms >= 0),
  increment_ms integer not null default 0 check (increment_ms >= 0),
  active_color text not null default 'w' check (active_color in ('w', 'b')),
  turn_started_at timestamptz,
  abandon_grace_seconds integer not null default 45 check (abandon_grace_seconds between 30 and 120),
  both_inactive_result text not null default 'draw' check (both_inactive_result in ('draw', 'aborted')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'active', 'declined', 'cancelled', 'expired', 'completed')),
  result text not null default 'pending' check (result in ('pending', 'white', 'black', 'draw', 'aborted')),
  termination text not null default '' check (length(termination) <= 48),
  fen text not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' check (length(fen) <= 256),
  moves jsonb not null default '[]'::jsonb,
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

create index if not exists game_challenges_participant_idx on public.game_challenges (creator_id, opponent_id, status, updated_at desc);
create index if not exists game_challenges_code_idx on public.game_challenges (code);
create index if not exists game_challenges_creator_recent_idx on public.game_challenges (creator_id, updated_at desc);
create index if not exists game_challenges_opponent_recent_idx on public.game_challenges (opponent_id, updated_at desc);
alter table public.game_challenges add column if not exists white_ms bigint not null default 600000 check (white_ms >= 0);
alter table public.game_challenges add column if not exists black_ms bigint not null default 600000 check (black_ms >= 0);
alter table public.game_challenges add column if not exists increment_ms integer not null default 0 check (increment_ms >= 0);
alter table public.game_challenges add column if not exists active_color text not null default 'w' check (active_color in ('w', 'b'));
alter table public.game_challenges add column if not exists turn_started_at timestamptz;
alter table public.game_challenges add column if not exists abandon_grace_seconds integer not null default 45 check (abandon_grace_seconds between 30 and 120);
alter table public.game_challenges add column if not exists both_inactive_result text not null default 'draw' check (both_inactive_result in ('draw', 'aborted'));
alter table public.game_challenges add column if not exists result text not null default 'pending' check (result in ('pending', 'white', 'black', 'draw', 'aborted'));
alter table public.game_challenges add column if not exists termination text not null default '' check (length(termination) <= 48);
alter table public.game_challenges add column if not exists revision bigint not null default 0 check (revision >= 0);

create table if not exists public.game_challenge_messages (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.game_challenges(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 240),
  created_at timestamptz not null default now()
);

create index if not exists game_challenge_messages_timeline_idx on public.game_challenge_messages (challenge_id, created_at desc);

create table if not exists public.game_challenge_presence (
  challenge_id uuid not null references public.game_challenges(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  connected boolean not null default true,
  last_seen timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (challenge_id, user_id)
);

create index if not exists game_challenge_presence_active_idx on public.game_challenge_presence (challenge_id, connected, last_seen desc);

create table if not exists public.player_achievements (
  user_id uuid not null references public.profiles(id) on delete cascade,
  achievement_key text not null check (length(achievement_key) between 3 and 80),
  earned_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  primary key (user_id, achievement_key)
);

do $$ begin
  alter publication supabase_realtime add table public.game_challenges;
exception when duplicate_object or undefined_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.game_challenge_messages;
exception when duplicate_object or undefined_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.game_challenge_presence;
exception when duplicate_object or undefined_object then null;
end $$;

alter table public.game_challenges enable row level security;
alter table public.game_challenge_messages enable row level security;
alter table public.game_challenge_presence enable row level security;
alter table public.player_achievements enable row level security;

drop policy if exists game_challenges_participant_read on public.game_challenges;
create policy game_challenges_participant_read on public.game_challenges
for select to authenticated
using (auth.uid() in (creator_id, opponent_id));

drop policy if exists game_challenge_messages_participant_read on public.game_challenge_messages;
create policy game_challenge_messages_participant_read on public.game_challenge_messages
for select to authenticated
using (exists (
  select 1 from public.game_challenges as challenge
  where challenge.id = game_challenge_messages.challenge_id
    and auth.uid() in (challenge.creator_id, challenge.opponent_id)
));

drop policy if exists game_challenge_presence_participant_read on public.game_challenge_presence;
create policy game_challenge_presence_participant_read on public.game_challenge_presence
for select to authenticated
using (exists (
  select 1 from public.game_challenges as challenge
  where challenge.id = game_challenge_presence.challenge_id
    and auth.uid() in (challenge.creator_id, challenge.opponent_id)
));

drop policy if exists player_achievements_owner_read on public.player_achievements;
create policy player_achievements_owner_read on public.player_achievements
for select to authenticated using (auth.uid() = user_id);

create or replace function public.finalize_game_challenge(
  p_challenge_id uuid,
  p_result text,
  p_termination text default 'game end'
)
returns public.game_challenges
language plpgsql
security definer set search_path = public
as $$
declare
  found public.game_challenges;
  white_user_id uuid;
  black_user_id uuid;
  winner_id uuid;
  loser_id uuid;
  white_rating integer;
  black_rating integer;
  white_expected numeric;
  white_score numeric;
  rating_delta integer;
begin
  select * into found from public.game_challenges where id = p_challenge_id for update;
  if found.id is null then raise exception 'Challenge not found'; end if;
  if found.status <> 'active' then return found; end if;
  if p_result not in ('white', 'black', 'draw', 'aborted') then raise exception 'Game result is invalid'; end if;

  update public.game_challenges
  set status = 'completed',
      result = p_result,
      termination = left(coalesce(nullif(trim(p_termination), ''), 'game end'), 48),
      revision = revision + 1,
      updated_at = now()
  where id = found.id
  returning * into found;

  -- Tournament results are settled by tournaments.sql so standings and rewards stay atomic there.
  if nullif(to_jsonb(found) ->> 'tournament_pairing_id', '') is not null or p_result = 'aborted' then return found; end if;

  white_user_id := case when found.creator_color = 'w' then found.creator_id else found.opponent_id end;
  black_user_id := case when found.creator_color = 'b' then found.creator_id else found.opponent_id end;
  if white_user_id is null or black_user_id is null then return found; end if;

  if p_result = 'white' then
    winner_id := white_user_id; loser_id := black_user_id; white_score := 1;
  elsif p_result = 'black' then
    winner_id := black_user_id; loser_id := white_user_id; white_score := 0;
  else
    white_score := .5;
  end if;

  select rating into white_rating from public.profiles where id = white_user_id;
  select rating into black_rating from public.profiles where id = black_user_id;
  if white_rating is not null and black_rating is not null then
    white_expected := 1 / (1 + power(10::numeric, (black_rating - white_rating)::numeric / 400));
    rating_delta := round(16 * (white_score - white_expected));
    update public.profiles set rating = greatest(400, least(3000, rating + rating_delta)), updated_at = now() where id = white_user_id;
    update public.profiles set rating = greatest(400, least(3000, rating - rating_delta)), updated_at = now() where id = black_user_id;
  end if;

  if p_result = 'draw' then
    update public.profiles
    set draws = draws + 1, xp = xp + 15, coins = coins + 8, updated_at = now()
    where id in (white_user_id, black_user_id);
  else
    update public.profiles
    set wins = wins + 1, xp = xp + 25, coins = coins + 20, updated_at = now()
    where id = winner_id;
    update public.profiles
    set losses = losses + 1, xp = xp + 8, updated_at = now()
    where id = loser_id;
    if p_termination = 'abandonment' then
      insert into public.player_achievements (user_id, achievement_key, metadata)
      values (winner_id, 'steadfast-player', jsonb_build_object('challengeId', found.id, 'reason', 'abandonment'))
      on conflict (user_id, achievement_key) do update set earned_at = now(), metadata = excluded.metadata;
    end if;
  end if;
  return found;
end;
$$;

create or replace function public.expire_game_challenges()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  found public.game_challenges;
  white_user_id uuid;
  black_user_id uuid;
  white_last_seen timestamptz;
  black_last_seen timestamptz;
  cutoff timestamptz;
begin
  update public.game_challenges
  set status = 'expired', revision = revision + 1, updated_at = now()
  where status in ('pending', 'accepted') and expires_at < now();

  for found in
    select * from public.game_challenges
    where status = 'active' and clock <> 'none' and turn_started_at is not null
      and extract(epoch from now() - turn_started_at) * 1000 >= case when active_color = 'w' then white_ms else black_ms end
    for update skip locked
  loop
    if found.active_color = 'w' then
      update public.game_challenges set white_ms = 0 where id = found.id;
      perform public.finalize_game_challenge(found.id, 'black', 'timeout');
    else
      update public.game_challenges set black_ms = 0 where id = found.id;
      perform public.finalize_game_challenge(found.id, 'white', 'timeout');
    end if;
  end loop;

  for found in
    select * from public.game_challenges where status = 'active' for update skip locked
  loop
    white_user_id := case when found.creator_color = 'w' then found.creator_id else found.opponent_id end;
    black_user_id := case when found.creator_color = 'b' then found.creator_id else found.opponent_id end;
    if white_user_id is null or black_user_id is null then continue; end if;
    cutoff := now() - make_interval(secs => found.abandon_grace_seconds);
    select max(last_seen) into white_last_seen from public.game_challenge_presence where challenge_id = found.id and user_id = white_user_id;
    select max(last_seen) into black_last_seen from public.game_challenge_presence where challenge_id = found.id and user_id = black_user_id;
    white_last_seen := coalesce(white_last_seen, found.turn_started_at, found.created_at);
    black_last_seen := coalesce(black_last_seen, found.turn_started_at, found.created_at);
    if white_last_seen > cutoff or black_last_seen > cutoff then
      if white_last_seen <= cutoff then perform public.finalize_game_challenge(found.id, 'black', 'abandonment'); end if;
      if black_last_seen <= cutoff then perform public.finalize_game_challenge(found.id, 'white', 'abandonment'); end if;
    elsif white_last_seen <= cutoff and black_last_seen <= cutoff then
      perform public.finalize_game_challenge(found.id, found.both_inactive_result, 'both players inactive');
    end if;
  end loop;

  delete from public.game_challenges
  where status in ('declined', 'cancelled', 'expired', 'completed')
    and updated_at < now() - interval '7 days';
end;
$$;

create or replace function public.challenge_payload(p_challenge public.game_challenges)
returns jsonb
language sql
security definer set search_path = public
stable
as $$
  select jsonb_build_object(
    'id', challenge.id,
    'code', challenge.code,
    'creatorId', challenge.creator_id,
    'creatorName', coalesce(creator.username, 'Friend'),
    'creatorProfile', jsonb_build_object(
      'id', creator.id,
      'username', coalesce(creator.username, 'Chess Player'),
      'displayName', coalesce(creator.username, 'Chess Player'),
      'avatar', coalesce(creator.avatar, 'auto'),
      'countryFlag', coalesce(to_jsonb(creator) ->> 'country_flag', ''),
      'title', coalesce(creator.title, ''),
      'rating', coalesce(creator.rating, 450),
      'online', coalesce((
        select presence.connected and presence.last_seen > now() - make_interval(secs => challenge.abandon_grace_seconds)
        from public.game_challenge_presence presence
        where presence.challenge_id = challenge.id and presence.user_id = creator.id
      ), creator.last_login_at > now() - interval '5 minutes', false)
    ),
    'opponentId', challenge.opponent_id,
    'opponentName', coalesce(opponent.username, ''),
    'opponentProfile', case when opponent.id is null then null else jsonb_build_object(
      'id', opponent.id,
      'username', coalesce(opponent.username, 'Chess Player'),
      'displayName', coalesce(opponent.username, 'Chess Player'),
      'avatar', coalesce(opponent.avatar, 'auto'),
      'countryFlag', coalesce(to_jsonb(opponent) ->> 'country_flag', ''),
      'title', coalesce(opponent.title, ''),
      'rating', coalesce(opponent.rating, 450),
      'online', coalesce((
        select presence.connected and presence.last_seen > now() - make_interval(secs => challenge.abandon_grace_seconds)
        from public.game_challenge_presence presence
        where presence.challenge_id = challenge.id and presence.user_id = opponent.id
      ), opponent.last_login_at > now() - interval '5 minutes', false)
    ) end,
    'creatorColor', challenge.creator_color,
    'inviteType', challenge.invite_type,
    'gameType', challenge.game_type,
    'clock', challenge.clock,
    'clockState', jsonb_build_object(
      'whiteMs', challenge.white_ms,
      'blackMs', challenge.black_ms,
      'incrementMs', challenge.increment_ms,
      'activeColor', challenge.active_color,
      'turnStartedAt', challenge.turn_started_at,
      'running', challenge.status = 'active' and challenge.clock <> 'none',
      'serverNow', now()
    ),
    'status', challenge.status,
    'result', challenge.result,
    'termination', challenge.termination,
    'fen', challenge.fen,
    'moves', challenge.moves,
    'revision', challenge.revision,
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', note.id,
        'userId', note.user_id,
        'username', coalesce(author.username, 'Player'),
        'body', note.body,
        'createdAt', note.created_at
      ) order by note.created_at asc)
      from (
        select message.*
        from public.game_challenge_messages as message
        where message.challenge_id = challenge.id
        order by message.created_at desc
        limit 50
      ) as note
      left join public.profiles as author on author.id = note.user_id
    ), '[]'::jsonb),
    'updatedAt', challenge.updated_at,
    'expiresAt', challenge.expires_at
  )
  from public.game_challenges as challenge
  left join public.profiles as creator on creator.id = challenge.creator_id
  left join public.profiles as opponent on opponent.id = challenge.opponent_id
  where challenge.id = p_challenge.id;
$$;

create or replace function public.touch_game_challenge_presence(
  p_code text,
  p_connected boolean default true
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  found public.game_challenges;
begin
  if current_user_id is null then raise exception 'Sign in to update game presence'; end if;
  perform public.expire_game_challenges();
  select * into found from public.game_challenges where code = upper(trim(p_code)) for update;
  if found.id is null then raise exception 'Challenge not found'; end if;
  if current_user_id not in (found.creator_id, found.opponent_id) then raise exception 'You are not in this game'; end if;
  if found.status = 'active' then
    insert into public.game_challenge_presence (challenge_id, user_id, connected, last_seen, updated_at)
    values (found.id, current_user_id, coalesce(p_connected, true), now(), now())
    on conflict (challenge_id, user_id) do update
      set connected = excluded.connected, last_seen = excluded.last_seen, updated_at = excluded.updated_at;
  end if;
  return public.challenge_payload(found);
end;
$$;

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
  creator_color text := case when p_color = 'b' then 'b' when p_color = 'w' then 'w' when random() < .5 then 'w' else 'b' end;
  clock_value text := case when p_clock = 'none' or p_clock ~ '^[0-9]{1,3}[+][0-9]{1,3}$' then p_clock else '10+0' end;
  base_ms bigint;
  increment_value integer;
begin
  if current_user_id is null then raise exception 'Sign in to create a challenge'; end if;
  if p_code !~ '^[A-Z2-9]{8,16}$' then raise exception 'Challenge code is invalid'; end if;
  if p_target_id = current_user_id then raise exception 'Choose another registered player'; end if;
  if p_target_id is not null and not exists (select 1 from public.profiles where id = p_target_id and not coalesce(is_bot, false)) then
    raise exception 'That player is unavailable';
  end if;
  base_ms := case when clock_value = 'none' then 0 else least(1440, greatest(0, split_part(clock_value, '+', 1)::integer)) * 60000 end;
  increment_value := case when clock_value = 'none' then 0 else least(120, greatest(0, split_part(clock_value, '+', 2)::integer)) * 1000 end;
  insert into public.game_challenges (code, creator_id, opponent_id, invite_type, game_type, creator_color, clock, expires_at)
  values (p_code, current_user_id, p_target_id, case when p_invite_type = 'public' then 'public' else 'private' end, case when p_game_type = 'rated' then 'rated' else 'casual' end, creator_color, clock_value, now() + interval '24 hours')
  returning * into created;
  update public.game_challenges
  set white_ms = base_ms, black_ms = base_ms, increment_ms = increment_value, active_color = 'w', turn_started_at = null
  where id = created.id
  returning * into created;
  return public.challenge_payload(created);
end;
$$;

create or replace function public.get_game_challenge(p_code text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  found public.game_challenges;
begin
  if current_user_id is null then raise exception 'Sign in to open a challenge'; end if;
  perform public.expire_game_challenges();
  select * into found from public.game_challenges where code = upper(trim(p_code));
  if found.id is null then raise exception 'Challenge not found or expired'; end if;
  if found.creator_id <> current_user_id and found.opponent_id is distinct from current_user_id and not (found.opponent_id is null and found.status = 'pending') then
    raise exception 'This challenge belongs to another player';
  end if;
  return public.challenge_payload(found);
end;
$$;

create or replace function public.respond_game_challenge(p_code text, p_response text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  found public.game_challenges;
begin
  if current_user_id is null then raise exception 'Sign in to respond to a challenge'; end if;
  select * into found from public.game_challenges where code = upper(trim(p_code)) for update;
  if found.id is null or found.expires_at < now() then raise exception 'Challenge not found or expired'; end if;
  if p_response = 'cancel' and found.creator_id = current_user_id and found.status in ('pending', 'accepted') then
    update public.game_challenges set status = 'cancelled', revision = revision + 1, updated_at = now() where id = found.id returning * into found;
  elsif p_response = 'decline' and found.opponent_id = current_user_id and found.status = 'pending' then
    update public.game_challenges set status = 'declined', revision = revision + 1, updated_at = now() where id = found.id returning * into found;
  elsif p_response = 'accept' and found.creator_id <> current_user_id and found.status = 'pending' and (found.opponent_id is null or found.opponent_id = current_user_id) then
    update public.game_challenges
    set opponent_id = current_user_id,
        status = 'active',
        active_color = 'w',
        turn_started_at = case when clock = 'none' then null else now() end,
        revision = revision + 1,
        updated_at = now()
    where id = found.id
    returning * into found;
  else
    raise exception 'That challenge cannot be changed';
  end if;
  return public.challenge_payload(found);
end;
$$;

drop function if exists public.save_game_challenge_position(text, text, jsonb, text);
drop function if exists public.save_game_challenge_position(text, text, jsonb, text, boolean);
drop function if exists public.save_game_challenge_position(text, text, jsonb, text, boolean, bigint);
create or replace function public.save_game_challenge_position(
  p_code text,
  p_fen text,
  p_moves jsonb,
  p_status text default 'active',
  p_move_applied boolean default false,
  p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  found public.game_challenges;
  active_user_id uuid;
  actor_color text;
  elapsed_ms bigint;
  remaining_ms bigint;
  existing_count integer;
  submitted_count integer;
  board_move_count integer;
  move_index integer;
  new_item text;
  active_draw_offer text := '';
  completion_result text := 'aborted';
  completion_termination text := 'ended';
begin
  if current_user_id is null then raise exception 'Sign in to save a friend game'; end if;
  perform public.expire_game_challenges();
  select * into found from public.game_challenges where code = upper(trim(p_code)) for update;
  if found.id is null then raise exception 'Challenge not found'; end if;
  if current_user_id <> found.creator_id and current_user_id <> found.opponent_id then raise exception 'You are not in this game'; end if;
  if found.status <> 'active' then raise exception 'This challenge is not ready to play'; end if;
  if length(coalesce(p_fen, '')) < 8 or length(p_fen) > 256 or jsonb_typeof(coalesce(p_moves, '[]'::jsonb)) <> 'array' then raise exception 'Game state is invalid'; end if;
  if p_expected_revision is not null and p_expected_revision <> found.revision then
    raise exception 'This game changed on another device. Reconnecting…' using errcode = '40001';
  end if;

  existing_count := jsonb_array_length(found.moves);
  submitted_count := jsonb_array_length(p_moves);
  if submitted_count < existing_count or submitted_count > existing_count + 1 then
    raise exception 'Game history must advance one action at a time';
  end if;
  if existing_count > 0 then
    for move_index in 0..existing_count - 1 loop
      if found.moves -> move_index is distinct from p_moves -> move_index then
        raise exception 'Game history changed on another device. Reconnecting…' using errcode = '40001';
      end if;
      new_item := found.moves ->> move_index;
      if new_item ~ '^__draw_offer:[wb]$' then
        active_draw_offer := new_item;
      elsif new_item in ('__draw_decline', '__draw_accept') then
        active_draw_offer := '';
      end if;
    end loop;
  end if;
  if submitted_count = existing_count then
    if p_fen <> found.fen or p_status <> 'active' or p_move_applied then
      raise exception 'Game update did not contain a new action';
    end if;
    return public.challenge_payload(found);
  end if;

  new_item := p_moves ->> existing_count;
  actor_color := case
    when current_user_id = found.creator_id then found.creator_color
    else case when found.creator_color = 'w' then 'b' else 'w' end
  end;

  select count(*) into board_move_count
  from jsonb_array_elements_text(found.moves) as item(value)
  where item.value ~ '^[a-h][1-8][a-h][1-8][qrbn]?$';

  if new_item ~ '^[a-h][1-8][a-h][1-8][qrbn]?$' then
    if not p_move_applied or p_status <> 'active' then raise exception 'A board move must be submitted as an active turn'; end if;
    active_user_id := case
      when found.active_color = 'w' and found.creator_color = 'w' then found.creator_id
      when found.active_color = 'w' then found.opponent_id
      when found.creator_color = 'b' then found.creator_id
      else found.opponent_id
    end;
    if active_user_id is distinct from current_user_id then raise exception 'It is not your turn'; end if;

    if found.clock <> 'none' then
      elapsed_ms := greatest(0, floor(extract(epoch from now() - coalesce(found.turn_started_at, now())) * 1000));
      remaining_ms := case when found.active_color = 'w'
        then greatest(0, found.white_ms - elapsed_ms)
        else greatest(0, found.black_ms - elapsed_ms)
      end;
      if remaining_ms = 0 then
        update public.game_challenges
        set white_ms = case when found.active_color = 'w' then 0 else white_ms end,
            black_ms = case when found.active_color = 'b' then 0 else black_ms end,
            revision = revision + 1,
            updated_at = now()
        where id = found.id
        returning * into found;
        select * into found from public.finalize_game_challenge(found.id, case when found.active_color = 'w' then 'black' else 'white' end, 'timeout');
        return public.challenge_payload(found);
      end if;
      if found.active_color = 'w' then
        update public.game_challenges
        set white_ms = remaining_ms + increment_ms, active_color = 'b', turn_started_at = now(), revision = revision + 1, updated_at = now()
        where id = found.id
        returning * into found;
      else
        update public.game_challenges
        set black_ms = remaining_ms + increment_ms, active_color = 'w', turn_started_at = now(), revision = revision + 1, updated_at = now()
        where id = found.id
        returning * into found;
      end if;
    else
      update public.game_challenges
      set active_color = case when found.active_color = 'w' then 'b' else 'w' end, revision = revision + 1, updated_at = now()
      where id = found.id
      returning * into found;
    end if;
    update public.game_challenges
    set fen = p_fen,
        moves = p_moves,
        updated_at = now()
    where id = found.id
    returning * into found;
    return public.challenge_payload(found);
  end if;

  if p_move_applied or p_fen <> found.fen then raise exception 'Only a legal board move may change the position'; end if;
  if new_item ~ '^__draw_offer:[wb]$' then
    if p_status <> 'active' or split_part(new_item, ':', 2) <> actor_color then raise exception 'Draw offer is invalid'; end if;
  elsif new_item = '__draw_decline' then
    if p_status <> 'active' or active_draw_offer = '' or split_part(active_draw_offer, ':', 2) = actor_color then raise exception 'There is no draw offer to decline'; end if;
  elsif new_item = '__draw_accept' then
    if p_status <> 'completed' or active_draw_offer = '' or split_part(active_draw_offer, ':', 2) = actor_color then raise exception 'There is no draw offer to accept'; end if;
    completion_result := 'draw'; completion_termination := 'draw agreement';
  elsif new_item ~ '^__resign:[wb]$' then
    if p_status <> 'completed' or split_part(new_item, ':', 2) <> actor_color then raise exception 'Resignation is invalid'; end if;
    completion_result := case when actor_color = 'w' then 'black' else 'white' end; completion_termination := 'resignation';
  elsif new_item = '__abort' then
    if p_status <> 'completed' or board_move_count >= 2 then raise exception 'Abort is only available before move 2'; end if;
    completion_result := 'aborted'; completion_termination := 'aborted';
  elsif new_item ~ '^__result:(white|black|draw|aborted):[a-z_]+$' then
    if p_status <> 'completed' then raise exception 'Game result is invalid'; end if;
    completion_result := split_part(new_item, ':', 2);
    completion_termination := replace(split_part(new_item, ':', 3), '_', ' ');
  else
    raise exception 'Game action is invalid';
  end if;

  update public.game_challenges
  set moves = p_moves,
      revision = revision + 1,
      updated_at = now()
  where id = found.id
  returning * into found;
  if p_status = 'completed' then
    select * into found from public.finalize_game_challenge(found.id, completion_result, completion_termination);
  end if;
  return public.challenge_payload(found);
end;
$$;

create or replace function public.send_game_challenge_message(p_code text, p_body text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  found public.game_challenges;
  clean_body text := left(trim(coalesce(p_body, '')), 240);
begin
  if current_user_id is null then raise exception 'Sign in to chat'; end if;
  select * into found from public.game_challenges where code = upper(trim(p_code));
  if found.id is null or current_user_id not in (found.creator_id, found.opponent_id) then raise exception 'This game is unavailable'; end if;
  if found.status not in ('active', 'completed') then raise exception 'Chat is available once the game starts'; end if;
  if length(clean_body) = 0 then raise exception 'Write a short message first'; end if;
  insert into public.game_challenge_messages (challenge_id, user_id, body) values (found.id, current_user_id, clean_body);
  return public.challenge_payload(found);
end;
$$;

create or replace function public.list_game_challenges()
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  result jsonb;
begin
  if current_user_id is null then raise exception 'Sign in to view challenges'; end if;
  perform public.expire_game_challenges();
  select coalesce(jsonb_agg(public.challenge_payload(challenge) order by challenge.updated_at desc), '[]'::jsonb)
  into result
  from public.game_challenges as challenge
  where (challenge.creator_id = current_user_id or challenge.opponent_id = current_user_id)
    and (challenge.status in ('pending', 'accepted', 'active')
      or (challenge.status in ('declined', 'completed') and challenge.updated_at > now() - interval '1 day'));
  return result;
end;
$$;

revoke all on table public.game_challenges, public.game_challenge_messages, public.game_challenge_presence, public.player_achievements from anon, authenticated;
revoke all on function public.expire_game_challenges() from public;
revoke all on function public.finalize_game_challenge(uuid, text, text) from public;
revoke all on function public.challenge_payload(public.game_challenges) from public;
revoke all on function public.touch_game_challenge_presence(text, boolean) from public;
revoke all on function public.search_registered_players(text) from public;
revoke all on function public.create_game_challenge(uuid, text, text, text, text, text) from public;
revoke all on function public.get_game_challenge(text) from public;
revoke all on function public.respond_game_challenge(text, text) from public;
revoke all on function public.save_game_challenge_position(text, text, jsonb, text, boolean, bigint) from public;
revoke all on function public.list_game_challenges() from public;
revoke all on function public.send_game_challenge_message(text, text) from public;
grant execute on function public.search_registered_players(text) to authenticated;
grant execute on function public.create_game_challenge(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.get_game_challenge(text) to authenticated;
grant execute on function public.touch_game_challenge_presence(text, boolean) to authenticated;
grant execute on function public.respond_game_challenge(text, text) to authenticated;
grant execute on function public.save_game_challenge_position(text, text, jsonb, text, boolean, bigint) to authenticated;
grant execute on function public.list_game_challenges() to authenticated;
grant execute on function public.send_game_challenge_message(text, text) to authenticated;
