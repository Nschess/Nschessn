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

create or replace function public.search_registered_players(p_query text)
returns table (
  public_id uuid,
  username text,
  avatar text,
  rating integer,
  title text,
  last_login_at timestamptz
)
language sql
security definer set search_path = public
stable
as $$
  select profile.id, profile.username, profile.avatar, profile.rating, profile.title, profile.last_login_at
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
  status text not null default 'pending' check (status in ('pending', 'accepted', 'active', 'declined', 'cancelled', 'expired', 'completed')),
  fen text not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' check (length(fen) <= 256),
  moves jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

create index if not exists game_challenges_participant_idx on public.game_challenges (creator_id, opponent_id, status, updated_at desc);
create index if not exists game_challenges_code_idx on public.game_challenges (code);
alter table public.game_challenges add column if not exists white_ms bigint not null default 600000 check (white_ms >= 0);
alter table public.game_challenges add column if not exists black_ms bigint not null default 600000 check (black_ms >= 0);
alter table public.game_challenges add column if not exists increment_ms integer not null default 0 check (increment_ms >= 0);
alter table public.game_challenges add column if not exists active_color text not null default 'w' check (active_color in ('w', 'b'));
alter table public.game_challenges add column if not exists turn_started_at timestamptz;
alter table public.game_challenges enable row level security;

create or replace function public.expire_game_challenges()
returns void
language sql
security definer set search_path = public
as $$
  update public.game_challenges
  set status = 'expired', updated_at = now()
  where status in ('pending', 'accepted') and expires_at < now();

  delete from public.game_challenges
  where status in ('declined', 'cancelled', 'expired', 'completed')
    and updated_at < now() - interval '7 days';

  update public.game_challenges
  set status = 'completed', white_ms = 0, updated_at = now()
  where status = 'active' and clock <> 'none' and active_color = 'w' and turn_started_at is not null
    and extract(epoch from now() - turn_started_at) * 1000 >= white_ms;

  update public.game_challenges
  set status = 'completed', black_ms = 0, updated_at = now()
  where status = 'active' and clock <> 'none' and active_color = 'b' and turn_started_at is not null
    and extract(epoch from now() - turn_started_at) * 1000 >= black_ms;
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
    'opponentId', challenge.opponent_id,
    'opponentName', coalesce(opponent.username, ''),
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
    'fen', challenge.fen,
    'moves', challenge.moves,
    'updatedAt', challenge.updated_at,
    'expiresAt', challenge.expires_at
  )
  from public.game_challenges as challenge
  left join public.profiles as creator on creator.id = challenge.creator_id
  left join public.profiles as opponent on opponent.id = challenge.opponent_id
  where challenge.id = p_challenge.id;
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
    update public.game_challenges set status = 'cancelled', updated_at = now() where id = found.id returning * into found;
  elsif p_response = 'decline' and found.opponent_id = current_user_id and found.status = 'pending' then
    update public.game_challenges set status = 'declined', updated_at = now() where id = found.id returning * into found;
  elsif p_response = 'accept' and found.creator_id <> current_user_id and found.status = 'pending' and (found.opponent_id is null or found.opponent_id = current_user_id) then
    update public.game_challenges
    set opponent_id = current_user_id,
        status = 'active',
        active_color = 'w',
        turn_started_at = case when clock = 'none' then null else now() end,
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
create function public.save_game_challenge_position(
  p_code text,
  p_fen text,
  p_moves jsonb,
  p_status text default 'active',
  p_move_applied boolean default false
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  found public.game_challenges;
  active_user_id uuid;
  elapsed_ms bigint;
  remaining_ms bigint;
begin
  if current_user_id is null then raise exception 'Sign in to save a friend game'; end if;
  perform public.expire_game_challenges();
  select * into found from public.game_challenges where code = upper(trim(p_code)) for update;
  if found.id is null then raise exception 'Challenge not found'; end if;
  if current_user_id <> found.creator_id and current_user_id <> found.opponent_id then raise exception 'You are not in this game'; end if;
  if found.status <> 'active' then raise exception 'This challenge is not ready to play'; end if;
  if length(coalesce(p_fen, '')) < 8 or length(p_fen) > 256 or jsonb_typeof(coalesce(p_moves, '[]'::jsonb)) <> 'array' then raise exception 'Game state is invalid'; end if;

  if p_move_applied then
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
        set status = 'completed',
            white_ms = case when found.active_color = 'w' then 0 else white_ms end,
            black_ms = case when found.active_color = 'b' then 0 else black_ms end,
            updated_at = now()
        where id = found.id
        returning * into found;
        return public.challenge_payload(found);
      end if;
      if found.active_color = 'w' then
        update public.game_challenges
        set white_ms = remaining_ms + increment_ms, active_color = 'b', turn_started_at = now(), updated_at = now()
        where id = found.id
        returning * into found;
      else
        update public.game_challenges
        set black_ms = remaining_ms + increment_ms, active_color = 'w', turn_started_at = now(), updated_at = now()
        where id = found.id
        returning * into found;
      end if;
    else
      update public.game_challenges
      set active_color = case when found.active_color = 'w' then 'b' else 'w' end, updated_at = now()
      where id = found.id
      returning * into found;
    end if;
  end if;

  update public.game_challenges
  set fen = p_fen, moves = coalesce(p_moves, '[]'::jsonb), status = case when p_status = 'completed' then 'completed' else 'active' end, updated_at = now()
  where id = found.id
  returning * into found;
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
      or (challenge.status = 'declined' and challenge.updated_at > now() - interval '1 day'));
  return result;
end;
$$;

revoke all on table public.game_challenges from anon, authenticated;
revoke all on function public.expire_game_challenges() from public;
revoke all on function public.challenge_payload(public.game_challenges) from public;
revoke all on function public.search_registered_players(text) from public;
revoke all on function public.create_game_challenge(uuid, text, text, text, text, text) from public;
revoke all on function public.get_game_challenge(text) from public;
revoke all on function public.respond_game_challenge(text, text) from public;
revoke all on function public.save_game_challenge_position(text, text, jsonb, text, boolean) from public;
revoke all on function public.list_game_challenges() from public;
grant execute on function public.search_registered_players(text) to authenticated;
grant execute on function public.create_game_challenge(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.get_game_challenge(text) to authenticated;
grant execute on function public.respond_game_challenge(text, text) to authenticated;
grant execute on function public.save_game_challenge_position(text, text, jsonb, text, boolean) to authenticated;
grant execute on function public.list_game_challenges() to authenticated;
