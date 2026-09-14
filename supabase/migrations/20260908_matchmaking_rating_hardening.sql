-- Competitive matchmaking hardening.
-- Casual games still award their existing progression rewards, but only rated
-- games may change the server-authoritative player rating.

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

  if found.game_type = 'rated' then
    select rating into white_rating from public.profiles where id = white_user_id;
    select rating into black_rating from public.profiles where id = black_user_id;
    if white_rating is not null and black_rating is not null then
      white_expected := 1 / (1 + power(10::numeric, (black_rating - white_rating)::numeric / 400));
      rating_delta := round(16 * (white_score - white_expected));
      update public.profiles set rating = greatest(400, least(3000, rating + rating_delta)), updated_at = now() where id = white_user_id;
      update public.profiles set rating = greatest(400, least(3000, rating - rating_delta)), updated_at = now() where id = black_user_id;
    end if;
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

revoke all on function public.finalize_game_challenge(uuid, text, text) from public;
