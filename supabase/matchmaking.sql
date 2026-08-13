-- Quick Match queue over game_challenges. Run after supabase/friends.sql.
-- Existing installations should also apply migrations/20260814_intelligent_quick_match.sql
-- for server-owned state, heartbeat cleanup, realtime pairing, and AI fallback.
-- Pairing creates an active game_challenges row; the existing friend game engine handles play.

alter table public.game_challenges
  add column if not exists match_source text not null default 'direct'
  check (match_source in ('direct', 'matchmaking', 'tournament'));

create table if not exists public.matchmaking_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  queue text not null default 'quick' check (queue in ('quick')),
  clock text not null check (clock = 'none' or clock ~ '^[0-9]{1,3}[+][0-9]{1,3}$'),
  game_type text not null check (game_type in ('casual', 'rated')),
  preferred_color text not null default 'random' check (preferred_color in ('w', 'b', 'random')),
  rating integer not null default 450 check (rating between 400 and 3000),
  joined_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  matched_code text check (matched_code is null or matched_code ~ '^[A-Z2-9]{8,16}$'),
  matched_at timestamptz
);

create index if not exists matchmaking_queue_pool_idx
  on public.matchmaking_queue (queue, clock, game_type, rating, joined_at);

alter table public.matchmaking_queue enable row level security;

drop policy if exists matchmaking_queue_owner_read on public.matchmaking_queue;
create policy matchmaking_queue_owner_read on public.matchmaking_queue
  for select to authenticated using (auth.uid() = user_id);

revoke all on table public.matchmaking_queue from anon, authenticated;

create or replace function public.make_game_challenge_code()
returns text
language plpgsql
security definer set search_path = public
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  next_code text;
  i integer;
begin
  loop
    next_code := '';
    for i in 1..10 loop
      next_code := next_code || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
    end loop;
    exit when not exists (select 1 from public.game_challenges where code = next_code);
  end loop;
  return next_code;
end;
$$;

create or replace function public.resolve_matchmaking_creator_color(
  creator_pref text,
  opponent_pref text
)
returns text
language plpgsql
immutable
as $$
begin
  if creator_pref = 'w' and opponent_pref <> 'w' then return 'w'; end if;
  if creator_pref = 'b' and opponent_pref <> 'b' then return 'b'; end if;
  if opponent_pref = 'w' and creator_pref <> 'w' then return 'b'; end if;
  if opponent_pref = 'b' and creator_pref <> 'b' then return 'w'; end if;
  return case when random() < 0.5 then 'w' else 'b' end;
end;
$$;

create or replace function public.expire_matchmaking_queue()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  delete from public.matchmaking_queue
  where expires_at < now()
     or (matched_code is not null and matched_at < now() - interval '15 minutes');
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
    'ticketId', p_ticket.id,
    'queue', p_ticket.queue,
    'clock', p_ticket.clock,
    'gameType', p_ticket.game_type,
    'preferredColor', p_ticket.preferred_color,
    'joinedAt', p_ticket.joined_at,
    'waitSeconds', greatest(0, floor(extract(epoch from now() - p_ticket.joined_at)))::integer,
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
  wait_seconds numeric;
  rating_band integer;
  code_value text;
  creator_color text;
  base_ms bigint;
  increment_value integer;
  created public.game_challenges;
begin
  perform public.expire_matchmaking_queue();
  select * into self_row
  from public.matchmaking_queue
  where user_id = p_user_id
  for update;

  if self_row.id is null then
    return null;
  end if;

  if self_row.matched_code is not null then
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

  wait_seconds := greatest(0, extract(epoch from now() - self_row.joined_at));
  rating_band := least(800, 200 + floor(wait_seconds / 5)::integer * 50);

  select candidate.*
  into opponent_row
  from public.matchmaking_queue as candidate
  where candidate.user_id <> p_user_id
    and candidate.queue = self_row.queue
    and candidate.clock = self_row.clock
    and candidate.game_type = self_row.game_type
    and candidate.matched_code is null
    and candidate.expires_at > now()
    and abs(candidate.rating - self_row.rating) <= rating_band
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
    creator_row := self_row;
    opponent_user_row := opponent_row;
  else
    creator_row := opponent_row;
    opponent_user_row := self_row;
  end if;

  creator_color := public.resolve_matchmaking_creator_color(creator_row.preferred_color, opponent_user_row.preferred_color);
  code_value := public.make_game_challenge_code();
  base_ms := case
    when creator_row.clock = 'none' then 0
    else least(1440, greatest(0, split_part(creator_row.clock, '+', 1)::integer)) * 60000
  end;
  increment_value := case
    when creator_row.clock = 'none' then 0
    else least(120, greatest(0, split_part(creator_row.clock, '+', 2)::integer)) * 1000
  end;

  insert into public.game_challenges (
    code, creator_id, opponent_id, invite_type, game_type, creator_color, clock,
    white_ms, black_ms, increment_ms, active_color, turn_started_at, status, expires_at,
    match_source
  ) values (
    code_value, creator_row.user_id, opponent_user_row.user_id, 'private', creator_row.game_type, creator_color, creator_row.clock,
    base_ms, base_ms, increment_value, 'w', case when creator_row.clock = 'none' then null else now() end, 'active',
    now() + interval '24 hours', 'matchmaking'
  )
  returning * into created;

  update public.matchmaking_queue
  set matched_code = created.code,
      matched_at = now(),
      expires_at = now() + interval '15 minutes'
  where id in (self_row.id, opponent_row.id);

  select * into self_row from public.matchmaking_queue where id = self_row.id;
  return public.matchmaking_status_payload(self_row, 'matched', created.code);
end;
$$;

create or replace function public.join_matchmaking_queue(
  p_queue text default 'quick',
  p_clock text default '5+0',
  p_game_type text default 'casual',
  p_preferred_color text default 'random'
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  ticket public.matchmaking_queue;
  player_rating integer := 450;
  queue_value text := case when p_queue = 'quick' then 'quick' else 'quick' end;
  clock_value text := case when p_clock = 'none' or p_clock ~ '^[0-9]{1,3}[+][0-9]{1,3}$' then p_clock else '5+0' end;
  game_type_value text := case when p_game_type = 'rated' then 'rated' else 'casual' end;
  color_value text := case when p_preferred_color in ('w', 'b', 'random') then p_preferred_color else 'random' end;
  paired jsonb;
begin
  if current_user_id is null then raise exception 'Sign in to use Quick Match'; end if;
  perform public.expire_matchmaking_queue();

  select rating into player_rating from public.profiles where id = current_user_id;
  player_rating := greatest(400, least(3000, coalesce(player_rating, 450)));

  insert into public.matchmaking_queue (
    user_id, queue, clock, game_type, preferred_color, rating, joined_at, expires_at
  ) values (
    current_user_id, queue_value, clock_value, game_type_value, color_value, player_rating, now(), now() + interval '10 minutes'
  )
  on conflict (user_id) do update
    set queue = excluded.queue,
        clock = excluded.clock,
        game_type = excluded.game_type,
        preferred_color = excluded.preferred_color,
        rating = excluded.rating,
        joined_at = excluded.joined_at,
        expires_at = excluded.expires_at,
        matched_code = null,
        matched_at = null
  returning * into ticket;

  paired := public.try_pair_matchmaking_queue(current_user_id);
  if paired is not null then
    return paired;
  end if;

  select * into ticket from public.matchmaking_queue where user_id = current_user_id;
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
  perform public.expire_matchmaking_queue();

  select * into ticket
  from public.matchmaking_queue
  where id = p_ticket_id and user_id = current_user_id;

  if ticket.id is null then
    return jsonb_build_object('status', 'expired', 'ticketId', p_ticket_id);
  end if;

  if ticket.matched_code is not null then
    return public.matchmaking_status_payload(ticket, 'matched', ticket.matched_code);
  end if;

  paired := public.try_pair_matchmaking_queue(current_user_id);
  if paired is not null then
    return paired;
  end if;

  select * into ticket from public.matchmaking_queue where id = p_ticket_id and user_id = current_user_id;
  if ticket.id is null then
    return jsonb_build_object('status', 'expired', 'ticketId', p_ticket_id);
  end if;

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
  delete from public.matchmaking_queue
  where id = p_ticket_id
    and user_id = current_user_id
    and matched_code is null;
  return jsonb_build_object('status', 'left', 'ticketId', p_ticket_id);
end;
$$;

revoke all on function public.make_game_challenge_code() from public;
revoke all on function public.resolve_matchmaking_creator_color(text, text) from public;
revoke all on function public.expire_matchmaking_queue() from public;
revoke all on function public.matchmaking_status_payload(public.matchmaking_queue, text, text) from public;
revoke all on function public.try_pair_matchmaking_queue(uuid) from public;
revoke all on function public.join_matchmaking_queue(text, text, text, text) from public;
revoke all on function public.get_matchmaking_status(uuid) from public;
revoke all on function public.leave_matchmaking_queue(uuid) from public;

grant execute on function public.join_matchmaking_queue(text, text, text, text) to authenticated;
grant execute on function public.get_matchmaking_status(uuid) to authenticated;
grant execute on function public.leave_matchmaking_queue(uuid) to authenticated;
