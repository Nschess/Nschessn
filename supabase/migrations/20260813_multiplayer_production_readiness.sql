-- Multiplayer production-readiness hardening.
-- Apply after 20260812_messaging_privacy.sql and 20260812_strengthen_friend_security.sql.
-- This migration is additive: it preserves existing game_challenges rows and RPC signatures.

create table if not exists public.game_challenge_validation_events (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.game_challenges(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  game_type text not null,
  revision bigint not null,
  move_count integer not null default 0,
  status text not null,
  validation_state text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists game_challenge_validation_events_lookup
  on public.game_challenge_validation_events (challenge_id, created_at desc);

alter table public.game_challenge_validation_events enable row level security;
revoke all on table public.game_challenge_validation_events from anon, authenticated;

create or replace function public.validate_rated_game_challenge_update()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  item text;
  item_index integer;
  move_count integer := 0;
  fen_parts text[];
  terminal_ok boolean := true;
begin
  if new.game_type <> 'rated' then return new; end if;

  if jsonb_typeof(coalesce(new.moves, '[]'::jsonb)) <> 'array' then
    raise exception 'Rated game history must be an array';
  end if;

  fen_parts := regexp_split_to_array(new.fen, '\s+');
  if cardinality(fen_parts) <> 6
     or fen_parts[2] not in ('w', 'b')
     or fen_parts[4] !~ '^(\-|[a-h][36])$'
     or fen_parts[5] !~ '^[0-9]+$'
     or fen_parts[6] !~ '^[1-9][0-9]*$' then
    raise exception 'Rated game position is invalid';
  end if;

  if jsonb_array_length(new.moves) > 0 then
    for item_index in 0..jsonb_array_length(new.moves) - 1 loop
      item := new.moves ->> item_index;
      if item ~ '^[a-h][1-8][a-h][1-8][qrbn]?$' then
        move_count := move_count + 1;
      elsif item !~ '^(__draw_offer:[wb]|__draw_decline|__draw_accept|__resign:[wb]|__abort|__result:(white|black|draw|aborted):[a-z_]+)$' then
        raise exception 'Rated game action is invalid';
      end if;
    end loop;
  end if;

  if new.status = 'completed' then
    terminal_ok := lower(coalesce(new.termination, '')) in (
      'checkmate', 'stalemate', 'draw agreement', 'resignation', 'timeout',
      'repetition', 'threefold repetition', 'insufficient material',
      'fifty-move rule', '50-move rule', 'aborted', 'game end', 'game complete', 'ended'
    );
    if not terminal_ok then raise exception 'Rated game termination is invalid'; end if;
  end if;

  insert into public.game_challenge_validation_events(
    challenge_id, actor_id, game_type, revision, move_count, status, validation_state, details
  ) values (
    new.id, auth.uid(), new.game_type, new.revision, move_count, new.status,
    'server_shape_checked',
    jsonb_build_object(
      'fen_shape_checked', true,
      'uci_shape_checked', true,
      'terminal_shape_checked', new.status = 'completed',
      'legal_chess_engine_required', true
    )
  );
  return new;
end;
$$;

drop trigger if exists game_challenge_rated_validation on public.game_challenges;
create trigger game_challenge_rated_validation
after insert or update on public.game_challenges
for each row execute function public.validate_rated_game_challenge_update();

create or replace function public.get_game_challenge_spectator(p_code text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  found public.game_challenges;
  allowed_creator boolean;
  allowed_opponent boolean;
  payload jsonb;
begin
  if current_user_id is null then raise exception 'Sign in to watch a game'; end if;
  perform public.consume_social_rate_limit('challenge_spectate', 120, 3600);
  perform public.expire_game_challenges();
  select * into found from public.game_challenges where code = upper(trim(p_code));
  if found.id is null or found.status not in ('active', 'completed') then
    raise exception 'Game not found or no longer live';
  end if;
  if current_user_id in (found.creator_id, found.opponent_id) then
    return public.challenge_payload(found) || jsonb_build_object('viewerRole', 'participant');
  end if;

  allowed_creator := public.social_spectating_allowed(current_user_id, found.creator_id);
  allowed_opponent := found.opponent_id is not null
    and public.social_spectating_allowed(current_user_id, found.opponent_id);
  if not allowed_creator or not allowed_opponent then
    raise exception 'This game is not accepting spectators';
  end if;

  payload := public.challenge_payload(found);
  if not public.social_action_allowed(current_user_id, found.creator_id, 'message')
     or not public.social_action_allowed(current_user_id, found.opponent_id, 'message') then
    payload := jsonb_set(payload, '{messages}', '[]'::jsonb, true);
  end if;
  return payload || jsonb_build_object('viewerRole', 'spectator');
end;
$$;

revoke all on function public.get_game_challenge_spectator(text) from public;
grant execute on function public.get_game_challenge_spectator(text) to authenticated;
