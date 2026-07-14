-- Run after auth.sql and friends.sql. Safe to run more than once.
-- Tournaments reuse game_challenges, so the existing real-time board, clocks,
-- reconnect flow, player cards, and game review remain the single game system.

create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{8,16}$'),
  creator_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) between 3 and 60),
  format text not null check (format in ('arena', 'swiss')),
  visibility text not null default 'public' check (visibility in ('public', 'private')),
  clock text not null default '10+0' check (clock ~ '^[0-9]{1,3}[+][0-9]{1,3}$'),
  max_players integer not null default 16 check (max_players between 2 and 128),
  rounds integer not null default 3 check (rounds between 1 and 9),
  duration_minutes integer not null default 30 check (duration_minutes between 5 and 180),
  status text not null default 'draft' check (status in ('draft', 'running', 'paused', 'completed', 'cancelled')),
  current_round integer not null default 0,
  starts_at timestamptz,
  ends_at timestamptz,
  rewards_paid boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tournament_entries (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  score numeric(6,2) not null default 0,
  wins integer not null default 0,
  draws integer not null default 0,
  losses integer not null default 0,
  berserk_count integer not null default 0,
  bye_count integer not null default 0,
  withdrawn boolean not null default false,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

create table if not exists public.tournament_invites (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (tournament_id, receiver_id),
  check (sender_id <> receiver_id)
);

create table if not exists public.tournament_pairings (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  round_no integer not null check (round_no > 0),
  white_id uuid not null references auth.users(id) on delete cascade,
  black_id uuid not null references auth.users(id) on delete cascade,
  challenge_id uuid unique references public.game_challenges(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'completed', 'aborted')),
  result text not null default 'pending' check (result in ('pending', 'white', 'black', 'draw', 'aborted')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tournament_id, round_no, white_id, black_id),
  check (white_id <> black_id)
);

create table if not exists public.tournament_awards (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  place integer not null check (place between 1 and 3),
  coins integer not null default 0,
  xp integer not null default 0,
  achievement text not null,
  awarded_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

create table if not exists public.tournament_messages (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 240),
  created_at timestamptz not null default now()
);

alter table public.tournament_entries add column if not exists berserk_count integer not null default 0;

create index if not exists tournaments_status_idx on public.tournaments (status, visibility, created_at desc);
create index if not exists tournament_entries_standings_idx on public.tournament_entries (tournament_id, withdrawn, score desc, wins desc, joined_at);
create index if not exists tournament_pairings_active_idx on public.tournament_pairings (tournament_id, status, round_no);
create index if not exists tournament_invites_receiver_idx on public.tournament_invites (receiver_id, created_at desc);
create index if not exists tournament_messages_timeline_idx on public.tournament_messages (tournament_id, created_at desc);

alter table public.game_challenges add column if not exists tournament_pairing_id uuid references public.tournament_pairings(id) on delete set null;
create unique index if not exists game_challenges_tournament_pairing_idx on public.game_challenges (tournament_pairing_id) where tournament_pairing_id is not null;

do $$ begin
  alter publication supabase_realtime add table public.tournaments;
exception when duplicate_object or undefined_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.tournament_entries;
exception when duplicate_object or undefined_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.tournament_pairings;
exception when duplicate_object or undefined_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.tournament_messages;
exception when duplicate_object or undefined_object then null;
end $$;

alter table public.tournaments enable row level security;
alter table public.tournament_entries enable row level security;
alter table public.tournament_invites enable row level security;
alter table public.tournament_pairings enable row level security;
alter table public.tournament_awards enable row level security;
alter table public.tournament_messages enable row level security;

create or replace function public.make_tournament_code()
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
    exit when not exists (select 1 from public.tournaments where code = next_code);
  end loop;
  return next_code;
end;
$$;

create or replace function public.tournament_payload(p_tournament public.tournaments, p_viewer uuid default auth.uid())
returns jsonb
language sql
security definer set search_path = public
stable
as $$
  select jsonb_build_object(
    'id', tournament.id,
    'code', tournament.code,
    'title', tournament.title,
    'format', tournament.format,
    'visibility', tournament.visibility,
    'clock', tournament.clock,
    'maxPlayers', tournament.max_players,
    'rounds', tournament.rounds,
    'durationMinutes', tournament.duration_minutes,
    'status', tournament.status,
    'currentRound', tournament.current_round,
    'creatorId', tournament.creator_id,
    'creatorName', coalesce(host.username, 'Host'),
    'startsAt', tournament.starts_at,
    'endsAt', tournament.ends_at,
    'createdAt', tournament.created_at,
    'participantCount', (select count(*) from public.tournament_entries entry where entry.tournament_id = tournament.id and not entry.withdrawn),
    'joined', exists (select 1 from public.tournament_entries entry where entry.tournament_id = tournament.id and entry.user_id = p_viewer and not entry.withdrawn),
    'isHost', tournament.creator_id = p_viewer,
    'standings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'playerRank', standing.player_rank,
        'id', standing.user_id,
        'username', standing.username,
        'avatar', standing.avatar,
        'countryFlag', standing.country_flag,
        'title', standing.title,
        'rating', standing.rating,
        'score', standing.score,
        'wins', standing.wins,
        'draws', standing.draws,
        'losses', standing.losses,
        'gamesPlayed', standing.games_played,
        'berserk', standing.berserk_count,
        'tiebreak', standing.tiebreak,
        'withdrawn', standing.withdrawn
      ) order by standing.player_rank)
      from (
        select row_number() over (order by entry.score desc, entry.wins desc, entry.draws desc, entry.joined_at) as player_rank,
          entry.user_id, profile.username, profile.avatar, coalesce(to_jsonb(profile) ->> 'country_flag', '') as country_flag,
          profile.title, profile.rating, entry.score, entry.wins, entry.draws, entry.losses,
          entry.wins + entry.draws + entry.losses as games_played,
          entry.berserk_count,
          coalesce((
            select sum(opponent.score)
            from public.tournament_pairings previous_pairing
            join public.tournament_entries opponent on opponent.tournament_id = entry.tournament_id
              and opponent.user_id = case when previous_pairing.white_id = entry.user_id then previous_pairing.black_id else previous_pairing.white_id end
            where previous_pairing.tournament_id = entry.tournament_id
              and previous_pairing.status = 'completed'
              and entry.user_id in (previous_pairing.white_id, previous_pairing.black_id)
          ), 0) as tiebreak,
          entry.withdrawn, entry.joined_at
        from public.tournament_entries entry
        join public.profiles profile on profile.id = entry.user_id
        where entry.tournament_id = tournament.id
      ) standing
    ), '[]'::jsonb),
    'pairings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pairing.id,
        'round', pairing.round_no,
        'whiteId', pairing.white_id,
        'blackId', pairing.black_id,
        'whiteName', coalesce(white_profile.username, 'White'),
        'blackName', coalesce(black_profile.username, 'Black'),
        'whiteAvatar', coalesce(white_profile.avatar, 'auto'),
        'blackAvatar', coalesce(black_profile.avatar, 'auto'),
        'whiteFlag', coalesce(to_jsonb(white_profile) ->> 'country_flag', ''),
        'blackFlag', coalesce(to_jsonb(black_profile) ->> 'country_flag', ''),
        'whiteTitle', coalesce(white_profile.title, 'Chess Player'),
        'blackTitle', coalesce(black_profile.title, 'Chess Player'),
        'whiteRating', coalesce(white_profile.rating, 450),
        'blackRating', coalesce(black_profile.rating, 450),
        'status', pairing.status,
        'result', pairing.result,
        'challengeCode', challenge.code,
        'createdAt', pairing.created_at
      ) order by pairing.round_no desc, pairing.created_at desc)
      from public.tournament_pairings pairing
      join public.profiles white_profile on white_profile.id = pairing.white_id
      join public.profiles black_profile on black_profile.id = pairing.black_id
      left join public.game_challenges challenge on challenge.id = pairing.challenge_id
      where pairing.tournament_id = tournament.id
    ), '[]'::jsonb),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', message.id,
        'userId', message.user_id,
        'username', message.username,
        'avatar', message.avatar,
        'body', message.body,
        'createdAt', message.created_at
      ) order by message.created_at asc)
      from (
        select note.id, note.user_id, coalesce(profile.username, 'Player') as username,
          coalesce(profile.avatar, 'auto') as avatar, note.body, note.created_at
        from public.tournament_messages note
        join public.profiles profile on profile.id = note.user_id
        where note.tournament_id = tournament.id
        order by note.created_at desc
        limit 50
      ) message
    ), '[]'::jsonb),
    'myPairing', (
      select jsonb_build_object(
        'id', pairing.id,
        'round', pairing.round_no,
        'whiteId', pairing.white_id,
        'blackId', pairing.black_id,
        'status', pairing.status,
        'result', pairing.result,
        'challengeCode', challenge.code
      )
      from public.tournament_pairings pairing
      left join public.game_challenges challenge on challenge.id = pairing.challenge_id
      where pairing.tournament_id = tournament.id
        and p_viewer in (pairing.white_id, pairing.black_id)
        and pairing.status = 'active'
      order by pairing.created_at desc
      limit 1
    )
  )
  from public.tournaments tournament
  join public.profiles host on host.id = tournament.creator_id
  where tournament.id = p_tournament.id;
$$;

create or replace function public.tournament_create_pairing(p_tournament_id uuid, p_round integer, p_white uuid, p_black uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  event public.tournaments;
  challenge public.game_challenges;
  pairing public.tournament_pairings;
  code_value text;
  base_ms bigint;
  increment_value integer;
begin
  if p_white is null or p_black is null or p_white = p_black then return; end if;
  select * into event from public.tournaments where id = p_tournament_id;
  if event.id is null or event.status <> 'running' then return; end if;
  if exists (select 1 from public.tournament_pairings where tournament_id = p_tournament_id and status = 'active' and (p_white in (white_id, black_id) or p_black in (white_id, black_id))) then return; end if;
  code_value := public.make_tournament_code();
  base_ms := greatest(1, least(180, split_part(event.clock, '+', 1)::integer)) * 60000;
  increment_value := greatest(0, least(120, split_part(event.clock, '+', 2)::integer)) * 1000;
  insert into public.game_challenges (
    code, creator_id, opponent_id, invite_type, game_type, creator_color, clock,
    white_ms, black_ms, increment_ms, active_color, turn_started_at, status, expires_at
  ) values (
    code_value, p_white, p_black, 'private', 'rated', 'w', event.clock,
    base_ms, base_ms, increment_value, 'w', now(), 'active', now() + interval '6 hours'
  ) returning * into challenge;
  insert into public.tournament_pairings (tournament_id, round_no, white_id, black_id, challenge_id)
  values (p_tournament_id, p_round, p_white, p_black, challenge.id)
  returning * into pairing;
  update public.game_challenges set tournament_pairing_id = pairing.id where id = challenge.id;
end;
$$;

create or replace function public.pair_tournament_players(p_tournament_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  event public.tournaments;
  player record;
  waiting_player uuid;
begin
  select * into event from public.tournaments where id = p_tournament_id for update;
  if event.id is null or event.status <> 'running' then return; end if;
  if event.format = 'swiss' and exists (
    select 1 from public.tournament_pairings where tournament_id = event.id and round_no = event.current_round
  ) then return; end if;

  waiting_player := null;
  for player in
    select entry.user_id
    from public.tournament_entries entry
    where entry.tournament_id = event.id
      and not entry.withdrawn
      and (event.format <> 'arena' or not exists (
        select 1 from public.tournament_pairings pairing
        where pairing.tournament_id = event.id and pairing.status = 'active'
          and entry.user_id in (pairing.white_id, pairing.black_id)
      ))
    order by entry.score desc, entry.wins desc, entry.joined_at
  loop
    if waiting_player is null then
      waiting_player := player.user_id;
    else
      perform public.tournament_create_pairing(event.id, greatest(1, event.current_round), waiting_player, player.user_id);
      waiting_player := null;
    end if;
  end loop;

  if waiting_player is not null and event.format = 'swiss' then
    update public.tournament_entries
    set score = score + 1, bye_count = bye_count + 1, updated_at = now()
    where tournament_id = event.id and user_id = waiting_player;
  end if;
end;
$$;

create or replace function public.award_tournament_finish(p_tournament_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  event public.tournaments;
  award record;
  coin_reward integer;
  xp_reward integer;
begin
  select * into event from public.tournaments where id = p_tournament_id for update;
  if event.id is null or event.rewards_paid then return; end if;
  for award in
    select ranked.user_id, ranked.place
    from (
      select entry.user_id, row_number() over (order by entry.score desc, entry.wins desc, entry.draws desc, entry.joined_at) as place
      from public.tournament_entries entry
      where entry.tournament_id = event.id and not entry.withdrawn
    ) ranked where ranked.place <= 3
  loop
    coin_reward := case award.place when 1 then 300 when 2 then 160 else 90 end;
    xp_reward := case award.place when 1 then 180 when 2 then 100 else 60 end;
    insert into public.tournament_awards (tournament_id, user_id, place, coins, xp, achievement)
    values (event.id, award.user_id, award.place, coin_reward, xp_reward, case award.place when 1 then 'Tournament Champion' when 2 then 'Tournament Finalist' else 'Tournament Podium' end)
    on conflict (tournament_id, user_id) do nothing;
    update public.profiles
    set coins = coins + coin_reward,
        xp = xp + xp_reward,
        updated_at = now()
    where id = award.user_id;
  end loop;
  update public.tournaments set rewards_paid = true, updated_at = now() where id = event.id;
end;
$$;

create or replace function public.advance_tournament(p_tournament_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  event public.tournaments;
begin
  select * into event from public.tournaments where id = p_tournament_id for update;
  if event.id is null or event.status <> 'running' then return; end if;
  if exists (select 1 from public.tournament_pairings where tournament_id = event.id and status = 'active') then return; end if;
  if event.format = 'arena' then
    if event.ends_at <= now() then
      update public.tournaments set status = 'completed', updated_at = now() where id = event.id;
      perform public.award_tournament_finish(event.id);
    else
      update public.tournaments set current_round = current_round + 1, updated_at = now() where id = event.id;
      perform public.pair_tournament_players(event.id);
    end if;
  elsif event.current_round >= event.rounds then
    update public.tournaments set status = 'completed', updated_at = now() where id = event.id;
    perform public.award_tournament_finish(event.id);
  else
    update public.tournaments set current_round = current_round + 1, updated_at = now() where id = event.id;
    perform public.pair_tournament_players(event.id);
  end if;
end;
$$;

create or replace function public.settle_tournament_pairing(p_pairing_id uuid, p_result text, p_termination text default null)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  pairing public.tournament_pairings;
  challenge public.game_challenges;
  final_result text := p_result;
  white_rating integer;
  black_rating integer;
  white_expected numeric;
  white_score numeric;
  delta integer;
begin
  select * into pairing from public.tournament_pairings where id = p_pairing_id for update;
  if pairing.id is null then raise exception 'Tournament pairing not found'; end if;
  if pairing.status <> 'active' then return pairing.tournament_id; end if;
  select * into challenge from public.game_challenges where id = pairing.challenge_id for update;
  if challenge.id is not null and challenge.status = 'completed' and challenge.result in ('white', 'black', 'draw', 'aborted') then
    final_result := challenge.result;
  end if;
  if final_result not in ('white', 'black', 'draw', 'aborted') then raise exception 'Tournament result is invalid'; end if;

  update public.tournament_pairings
  set status = case when final_result = 'aborted' then 'aborted' else 'completed' end,
      result = final_result,
      completed_at = now()
  where id = pairing.id;

  update public.game_challenges
  set status = 'completed',
      result = final_result,
      termination = coalesce(nullif(termination, ''), nullif(p_termination, ''), case when final_result = 'aborted' then 'aborted' else 'tournament result' end),
      updated_at = now()
  where id = pairing.challenge_id;

  if final_result = 'white' then
    update public.tournament_entries set score = score + 1, wins = wins + 1, updated_at = now() where tournament_id = pairing.tournament_id and user_id = pairing.white_id;
    update public.tournament_entries set losses = losses + 1, updated_at = now() where tournament_id = pairing.tournament_id and user_id = pairing.black_id;
    update public.profiles set wins = wins + 1, xp = xp + 25, coins = coins + 20, updated_at = now() where id = pairing.white_id;
    update public.profiles set losses = losses + 1, xp = xp + 10, updated_at = now() where id = pairing.black_id;
  elsif final_result = 'black' then
    update public.tournament_entries set losses = losses + 1, updated_at = now() where tournament_id = pairing.tournament_id and user_id = pairing.white_id;
    update public.tournament_entries set score = score + 1, wins = wins + 1, updated_at = now() where tournament_id = pairing.tournament_id and user_id = pairing.black_id;
    update public.profiles set losses = losses + 1, xp = xp + 10, updated_at = now() where id = pairing.white_id;
    update public.profiles set wins = wins + 1, xp = xp + 25, coins = coins + 20, updated_at = now() where id = pairing.black_id;
  elsif final_result = 'draw' then
    update public.tournament_entries set score = score + .5, draws = draws + 1, updated_at = now() where tournament_id = pairing.tournament_id and user_id in (pairing.white_id, pairing.black_id);
    update public.profiles set draws = draws + 1, xp = xp + 15, coins = coins + 8, updated_at = now() where id in (pairing.white_id, pairing.black_id);
  end if;

  if final_result in ('white', 'black', 'draw') then
    select rating into white_rating from public.profiles where id = pairing.white_id;
    select rating into black_rating from public.profiles where id = pairing.black_id;
    white_expected := 1 / (1 + power(10::numeric, (black_rating - white_rating)::numeric / 400));
    white_score := case final_result when 'white' then 1 when 'black' then 0 else .5 end;
    delta := round(16 * (white_score - white_expected));
    update public.profiles set rating = greatest(400, least(3000, rating + delta)), updated_at = now() where id = pairing.white_id;
    update public.profiles set rating = greatest(400, least(3000, rating - delta)), updated_at = now() where id = pairing.black_id;
  end if;

  perform public.advance_tournament(pairing.tournament_id);
  return pairing.tournament_id;
end;
$$;

create or replace function public.expire_tournaments()
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  event record;
begin
  for event in
    select pairing.id as pairing_id, challenge.result, challenge.termination
    from public.tournament_pairings pairing
    join public.game_challenges challenge on challenge.id = pairing.challenge_id
    where pairing.status = 'active'
      and challenge.status = 'completed'
      and challenge.result in ('white', 'black', 'draw', 'aborted')
  loop
    perform public.settle_tournament_pairing(event.pairing_id, event.result, event.termination);
  end loop;
  for event in
    update public.tournament_pairings pairing
    set status = 'aborted', result = 'aborted', completed_at = now()
    from public.game_challenges challenge
    where pairing.challenge_id = challenge.id
      and pairing.status = 'active'
      and challenge.expires_at <= now()
    returning pairing.tournament_id, pairing.challenge_id
  loop
    update public.game_challenges set status = 'completed', result = 'aborted', termination = 'pairing expired', updated_at = now() where id = event.challenge_id;
    perform public.advance_tournament(event.tournament_id);
  end loop;
  for event in select id from public.tournaments where status = 'running' and format = 'arena' and ends_at <= now() loop
    update public.tournaments set status = 'completed', updated_at = now() where id = event.id;
    perform public.award_tournament_finish(event.id);
  end loop;
end;
$$;

create or replace function public.create_tournament(
  p_title text,
  p_format text,
  p_visibility text,
  p_clock text,
  p_max_players integer,
  p_rounds integer,
  p_duration_minutes integer
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  created public.tournaments;
begin
  if current_user_id is null then raise exception 'Sign in to create a tournament'; end if;
  insert into public.tournaments (code, creator_id, title, format, visibility, clock, max_players, rounds, duration_minutes)
  values (
    public.make_tournament_code(), current_user_id,
    left(trim(coalesce(p_title, '')), 60),
    case when p_format = 'swiss' then 'swiss' else 'arena' end,
    case when p_visibility = 'private' then 'private' else 'public' end,
    case when p_clock ~ '^[0-9]{1,3}[+][0-9]{1,3}$' then p_clock else '10+0' end,
    least(128, greatest(2, coalesce(p_max_players, 16))),
    least(9, greatest(1, coalesce(p_rounds, 3))),
    least(180, greatest(5, coalesce(p_duration_minutes, 30)))
  ) returning * into created;
  if length(created.title) < 3 then raise exception 'Tournament name needs at least 3 characters'; end if;
  insert into public.tournament_entries (tournament_id, user_id) values (created.id, current_user_id);
  return public.tournament_payload(created, current_user_id);
end;
$$;

create or replace function public.list_tournaments()
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  result jsonb;
begin
  if current_user_id is null then raise exception 'Sign in to view tournaments'; end if;
  perform public.expire_tournaments();
  select coalesce(jsonb_agg(public.tournament_payload(tournament, current_user_id) order by tournament.status = 'running' desc, tournament.created_at desc), '[]'::jsonb)
  into result
  from public.tournaments tournament
  where tournament.visibility = 'public'
     or tournament.creator_id = current_user_id
     or exists (select 1 from public.tournament_entries entry where entry.tournament_id = tournament.id and entry.user_id = current_user_id)
     or exists (select 1 from public.tournament_invites invite where invite.tournament_id = tournament.id and invite.receiver_id = current_user_id);
  return result;
end;
$$;

create or replace function public.get_tournament(p_code text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  event public.tournaments;
begin
  if current_user_id is null then raise exception 'Sign in to open a tournament'; end if;
  perform public.expire_tournaments();
  select * into event from public.tournaments where code = upper(trim(p_code));
  if event.id is null then raise exception 'Tournament not found'; end if;
  if event.visibility = 'private'
    and event.creator_id <> current_user_id
    and not exists (select 1 from public.tournament_entries where tournament_id = event.id and user_id = current_user_id)
    and not exists (select 1 from public.tournament_invites where tournament_id = event.id and receiver_id = current_user_id) then
    raise exception 'This private tournament requires an invite';
  end if;
  return public.tournament_payload(event, current_user_id);
end;
$$;

create or replace function public.join_tournament(p_code text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  event public.tournaments;
  player_count integer;
begin
  if current_user_id is null then raise exception 'Sign in to join a tournament'; end if;
  select * into event from public.tournaments where code = upper(trim(p_code)) for update;
  if event.id is null or event.status in ('completed', 'cancelled', 'paused') then raise exception 'This tournament is not open'; end if;
  if event.format = 'swiss' and event.status <> 'draft' then raise exception 'Swiss registration closes when round 1 starts'; end if;
  if event.visibility = 'private' and event.creator_id <> current_user_id and not exists (
    select 1 from public.tournament_invites where tournament_id = event.id and receiver_id = current_user_id
  ) then raise exception 'This private tournament requires an invite'; end if;
  select count(*) into player_count from public.tournament_entries where tournament_id = event.id and not withdrawn;
  if player_count >= event.max_players and not exists (select 1 from public.tournament_entries where tournament_id = event.id and user_id = current_user_id) then
    raise exception 'This tournament is full';
  end if;
  insert into public.tournament_entries (tournament_id, user_id) values (event.id, current_user_id)
  on conflict (tournament_id, user_id) do update set withdrawn = false, updated_at = now();
  delete from public.tournament_invites where tournament_id = event.id and receiver_id = current_user_id;
  if event.format = 'arena' and event.status = 'running' then perform public.pair_tournament_players(event.id); end if;
  select * into event from public.tournaments where id = event.id;
  return public.tournament_payload(event, current_user_id);
end;
$$;

create or replace function public.leave_tournament(p_code text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  event public.tournaments;
  pairing record;
begin
  select * into event from public.tournaments where code = upper(trim(p_code)) for update;
  if event.id is null then raise exception 'Tournament not found'; end if;
  if event.creator_id = current_user_id and event.status = 'draft' then raise exception 'Hosts can cancel a draft instead of leaving it'; end if;
  update public.tournament_entries set withdrawn = true, updated_at = now() where tournament_id = event.id and user_id = current_user_id;
  if not found then raise exception 'You have not joined this tournament'; end if;
  for pairing in select * from public.tournament_pairings where tournament_id = event.id and status = 'active' and current_user_id in (white_id, black_id) loop
    perform public.settle_tournament_pairing(pairing.id, case when pairing.white_id = current_user_id then 'black' else 'white' end, 'player left tournament');
  end loop;
  return public.tournament_payload(event, current_user_id);
end;
$$;

create or replace function public.invite_to_tournament(p_code text, p_target_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  event public.tournaments;
begin
  select * into event from public.tournaments where code = upper(trim(p_code));
  if event.id is null or event.creator_id <> auth.uid() then raise exception 'Only the host can invite players'; end if;
  if p_target_id is null or p_target_id = auth.uid() or not exists (select 1 from public.profiles where id = p_target_id and not coalesce(is_bot, false)) then raise exception 'Choose a registered player'; end if;
  insert into public.tournament_invites (tournament_id, sender_id, receiver_id)
  values (event.id, auth.uid(), p_target_id)
  on conflict (tournament_id, receiver_id) do nothing;
end;
$$;

create or replace function public.send_tournament_message(p_code text, p_body text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  event public.tournaments;
  current_user_id uuid := auth.uid();
  clean_body text := left(trim(coalesce(p_body, '')), 240);
begin
  if current_user_id is null then raise exception 'Sign in to chat'; end if;
  select * into event from public.tournaments where code = upper(trim(p_code));
  if event.id is null then raise exception 'Tournament not found'; end if;
  if not exists (
    select 1 from public.tournament_entries entry
    where entry.tournament_id = event.id and entry.user_id = current_user_id and not entry.withdrawn
  ) then raise exception 'Join this tournament to chat'; end if;
  if length(clean_body) = 0 then raise exception 'Write a short message first'; end if;
  insert into public.tournament_messages (tournament_id, user_id, body)
  values (event.id, current_user_id, clean_body);
  return public.tournament_payload(event, current_user_id);
end;
$$;

create or replace function public.tournament_host_action(p_code text, p_action text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  event public.tournaments;
  player_count integer;
begin
  select * into event from public.tournaments where code = upper(trim(p_code)) for update;
  if event.id is null or event.creator_id <> auth.uid() then raise exception 'Only the tournament host can manage this event'; end if;
  if p_action = 'start' then
    if event.status <> 'draft' then raise exception 'Only a draft can start'; end if;
    select count(*) into player_count from public.tournament_entries where tournament_id = event.id and not withdrawn;
    if player_count < 2 then raise exception 'At least two players are needed'; end if;
    update public.tournaments
    set status = 'running', current_round = 1, starts_at = now(), ends_at = case when format = 'arena' then now() + make_interval(mins => duration_minutes) else null end, updated_at = now()
    where id = event.id returning * into event;
    perform public.pair_tournament_players(event.id);
  elsif p_action = 'pause' and event.status = 'running' then
    update public.tournaments set status = 'paused', updated_at = now() where id = event.id returning * into event;
  elsif p_action = 'resume' and event.status = 'paused' then
    update public.tournaments set status = 'running', updated_at = now() where id = event.id returning * into event;
    perform public.pair_tournament_players(event.id);
  elsif p_action = 'end' and event.status in ('running', 'paused') then
    update public.tournaments set status = 'completed', updated_at = now() where id = event.id returning * into event;
    perform public.award_tournament_finish(event.id);
  elsif p_action = 'cancel' and event.status = 'draft' then
    update public.tournaments set status = 'cancelled', updated_at = now() where id = event.id returning * into event;
  else
    raise exception 'That tournament action is not available';
  end if;
  select * into event from public.tournaments where id = event.id;
  return public.tournament_payload(event, auth.uid());
end;
$$;

create or replace function public.report_tournament_result(p_pairing_id uuid, p_result text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  pairing public.tournament_pairings;
  event public.tournaments;
  event_id uuid;
begin
  select * into pairing from public.tournament_pairings where id = p_pairing_id for update;
  if pairing.id is null or current_user_id not in (pairing.white_id, pairing.black_id) then raise exception 'Tournament pairing not found'; end if;
  if pairing.status <> 'active' then return public.get_tournament((select code from public.tournaments where id = pairing.tournament_id)); end if;
  if p_result not in ('white', 'black', 'draw', 'aborted') then raise exception 'Tournament result is invalid'; end if;
  event_id := public.settle_tournament_pairing(pairing.id, p_result, 'tournament result');
  select * into event from public.tournaments where id = event_id;
  return public.get_tournament(event.code);
end;
$$;

revoke all on table public.tournaments, public.tournament_entries, public.tournament_invites, public.tournament_pairings, public.tournament_awards, public.tournament_messages from anon, authenticated;
revoke all on function public.make_tournament_code() from public;
revoke all on function public.tournament_payload(public.tournaments, uuid) from public;
revoke all on function public.tournament_create_pairing(uuid, integer, uuid, uuid) from public;
revoke all on function public.pair_tournament_players(uuid) from public;
revoke all on function public.award_tournament_finish(uuid) from public;
revoke all on function public.advance_tournament(uuid) from public;
revoke all on function public.settle_tournament_pairing(uuid, text, text) from public;
revoke all on function public.expire_tournaments() from public;
revoke all on function public.create_tournament(text, text, text, text, integer, integer, integer) from public;
revoke all on function public.list_tournaments() from public;
revoke all on function public.get_tournament(text) from public;
revoke all on function public.join_tournament(text) from public;
revoke all on function public.leave_tournament(text) from public;
revoke all on function public.invite_to_tournament(text, uuid) from public;
revoke all on function public.tournament_host_action(text, text) from public;
revoke all on function public.report_tournament_result(uuid, text) from public;
revoke all on function public.send_tournament_message(text, text) from public;
grant execute on function public.create_tournament(text, text, text, text, integer, integer, integer) to authenticated;
grant execute on function public.list_tournaments() to authenticated;
grant execute on function public.get_tournament(text) to authenticated;
grant execute on function public.join_tournament(text) to authenticated;
grant execute on function public.leave_tournament(text) to authenticated;
grant execute on function public.invite_to_tournament(text, uuid) to authenticated;
grant execute on function public.tournament_host_action(text, text) to authenticated;
grant execute on function public.report_tournament_result(uuid, text) to authenticated;
grant execute on function public.send_tournament_message(text, text) to authenticated;
