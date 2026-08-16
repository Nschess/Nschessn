-- Release-candidate security hardening.
-- Server-owned economy, competitive records, tournament results, and chess
-- move validation.  This migration is additive and safe on upgraded systems.

begin;

-- Client profile writes are limited to presentation/preferences.  Competitive
-- counters and wallet state are written only by trusted security-definer RPCs.
revoke update on public.profiles from authenticated;
grant update (avatar, country_flag, title, friends, last_login_at, updated_at, display_name)
  on public.profiles to authenticated;

-- Leaderboard rows are a public read model, never a client-owned document.
revoke insert, update, delete on public.leaderboard_entries from anon, authenticated;
drop policy if exists "leaderboard insert" on public.leaderboard_entries;
drop policy if exists "leaderboard update" on public.leaderboard_entries;

create or replace function public.sync_leaderboard_entry()
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  actor uuid := auth.uid();
  saved public.leaderboard_entries;
begin
  if actor is null then raise exception 'Sign in to sync leaderboard'; end if;
  insert into public.leaderboard_entries (
    public_id, username, country_flag, title, puzzle_rating, game_rating,
    achievements, statistics, updated_at
  )
  select
    profile.public_id,
    profile.username,
    profile.country_flag,
    profile.title,
    greatest(400, least(3000, profile.rating)),
    greatest(400, least(3000, profile.rating)),
    '[]'::jsonb,
    jsonb_build_object(
      'gamesPlayed', profile.wins + profile.losses + profile.draws,
      'wins', profile.wins,
      'losses', profile.losses,
      'draws', profile.draws
    ),
    now()
  from public.profiles profile
  where profile.id = actor
  on conflict (public_id) do update set
    username = excluded.username,
    country_flag = excluded.country_flag,
    title = excluded.title,
    puzzle_rating = excluded.puzzle_rating,
    game_rating = excluded.game_rating,
    achievements = excluded.achievements,
    statistics = excluded.statistics,
    updated_at = excluded.updated_at
  returning * into saved;
  if saved.public_id is null then raise exception 'Profile is unavailable'; end if;
  return to_jsonb(saved);
end;
$$;

revoke all on function public.sync_leaderboard_entry() from public;
grant execute on function public.sync_leaderboard_entry() to authenticated;

-- Reward crediting is an internal server hook.  The browser must not be able
-- to choose either the amount or the reason for a wallet credit.
revoke execute on function public.credit_store_reward(bigint, text, text) from anon, authenticated;
grant execute on function public.credit_store_reward(bigint, text, text) to service_role;

create or replace function public.ns_chess_square_file(p_square text)
returns integer
language sql immutable strict
as $$ select ascii(lower(substr(p_square, 1, 1))) - ascii('a') + 1 $$;

create or replace function public.ns_chess_square_rank(p_square text)
returns integer
language sql immutable strict
as $$ select substr(p_square, 2, 1)::integer $$;

create or replace function public.ns_chess_square(p_file integer, p_rank integer)
returns text
language sql immutable
as $$
  select case when p_file between 1 and 8 and p_rank between 1 and 8
    then chr(ascii('a') + p_file - 1) || p_rank::text end
$$;

create or replace function public.ns_chess_piece_color(p_piece text)
returns text
language sql immutable strict
as $$ select case when p_piece ~ '^[A-Z]$' then 'w' else 'b' end $$;

create or replace function public.ns_chess_parse_fen(p_fen text)
returns jsonb
language plpgsql immutable
as $$
declare
  parts text[];
  ranks text[];
  row_text text;
  piece text;
  board jsonb := '{}'::jsonb;
  rank_index integer;
  file_index integer;
  char_index integer;
  white_king integer := 0;
  black_king integer := 0;
begin
  parts := regexp_split_to_array(trim(coalesce(p_fen, '')), '\s+');
  if cardinality(parts) <> 6 then raise exception 'FEN must contain six fields'; end if;
  if parts[2] not in ('w', 'b') then raise exception 'FEN side-to-move is invalid'; end if;
  if parts[3] <> '-' and parts[3] !~ '^[KQkq]+$' then raise exception 'FEN castling rights are invalid'; end if;
  if parts[4] <> '-' and parts[4] !~ '^[a-h][36]$' then raise exception 'FEN en-passant square is invalid'; end if;
  if parts[5] !~ '^[0-9]+$' or parts[6] !~ '^[1-9][0-9]*$' then raise exception 'FEN counters are invalid'; end if;
  ranks := string_to_array(parts[1], '/');
  if cardinality(ranks) <> 8 then raise exception 'FEN board must contain eight ranks'; end if;
  for rank_index in 1..8 loop
    row_text := ranks[rank_index];
    file_index := 1;
    for char_index in 1..length(row_text) loop
      piece := substr(row_text, char_index, 1);
      if piece ~ '^[1-8]$' then
        file_index := file_index + piece::integer;
      elsif piece ~ '^[prnbqkPRNBQK]$' then
        if file_index > 8 then raise exception 'FEN rank is too wide'; end if;
        board := board || jsonb_build_object(public.ns_chess_square(file_index, 9 - rank_index), piece);
        if piece = 'K' then white_king := white_king + 1; end if;
        if piece = 'k' then black_king := black_king + 1; end if;
        file_index := file_index + 1;
      else
        raise exception 'FEN contains an invalid piece';
      end if;
    end loop;
    if file_index <> 9 then raise exception 'FEN rank is not eight files wide'; end if;
  end loop;
  if white_king <> 1 or black_king <> 1 then raise exception 'FEN must contain one king per side'; end if;
  return jsonb_build_object(
    'board', board,
    'turn', parts[2],
    'castling', parts[3],
    'ep', parts[4],
    'halfmove', parts[5]::integer,
    'fullmove', parts[6]::integer
  );
end;
$$;

create or replace function public.ns_chess_path_clear(
  p_board jsonb,
  p_from text,
  p_to text
)
returns boolean
language plpgsql immutable
as $$
declare
  from_file integer := public.ns_chess_square_file(p_from);
  from_rank integer := public.ns_chess_square_rank(p_from);
  to_file integer := public.ns_chess_square_file(p_to);
  to_rank integer := public.ns_chess_square_rank(p_to);
  step_file integer := sign(to_file - from_file);
  step_rank integer := sign(to_rank - from_rank);
  file_index integer := from_file + step_file;
  rank_index integer := from_rank + step_rank;
begin
  while file_index <> to_file or rank_index <> to_rank loop
    if p_board ? public.ns_chess_square(file_index, rank_index) then return false; end if;
    file_index := file_index + step_file;
    rank_index := rank_index + step_rank;
  end loop;
  return true;
end;
$$;

create or replace function public.ns_chess_find_king(p_board jsonb, p_color text)
returns text
language sql immutable
as $$
  select key from jsonb_each_text(p_board) as pieces(key, value)
  where value = case when p_color = 'w' then 'K' else 'k' end
  limit 1
$$;

create or replace function public.ns_chess_is_attacked(
  p_board jsonb,
  p_target text,
  p_by_color text
)
returns boolean
language plpgsql immutable
as $$
declare
  target_file integer := public.ns_chess_square_file(p_target);
  target_rank integer := public.ns_chess_square_rank(p_target);
  file_index integer;
  rank_index integer;
  square text;
  piece text;
  direction record;
  step integer;
begin
  if p_target is null or p_by_color not in ('w', 'b') then return false; end if;

  for file_index in select unnest(array[-1, 1]) loop
    square := public.ns_chess_square(
      target_file + file_index,
      target_rank + (case when p_by_color = 'w' then -1 else 1 end)
    );
    if square is not null
       and (p_board ->> square) = (case when p_by_color = 'w' then 'P' else 'p' end) then
      return true;
    end if;
  end loop;

  for direction in select * from (values
    (1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2)
  ) as offsets(file_delta, rank_delta) loop
    square := public.ns_chess_square(target_file + direction.file_delta, target_rank + direction.rank_delta);
    if square is not null
       and (p_board ->> square) = (case when p_by_color = 'w' then 'N' else 'n' end) then
      return true;
    end if;
  end loop;

  for direction in select * from (values
    (1, 1), (1, 0), (1, -1), (0, 1), (0, -1), (-1, 1), (-1, 0), (-1, -1)
  ) as offsets(file_delta, rank_delta) loop
    square := public.ns_chess_square(target_file + direction.file_delta, target_rank + direction.rank_delta);
    if square is not null
       and (p_board ->> square) = (case when p_by_color = 'w' then 'K' else 'k' end) then
      return true;
    end if;
  end loop;

  for direction in select * from (values
    (1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)
  ) as offsets(file_delta, rank_delta) loop
    step := 1;
    loop
      square := public.ns_chess_square(target_file + direction.file_delta * step, target_rank + direction.rank_delta * step);
      exit when square is null;
      piece := p_board ->> square;
      if piece is null then
        step := step + 1;
        continue;
      end if;
      if public.ns_chess_piece_color(piece) = p_by_color
         and ((direction.file_delta = 0 or direction.rank_delta = 0) and upper(piece) in ('R', 'Q')
           or (direction.file_delta <> 0 and direction.rank_delta <> 0) and upper(piece) in ('B', 'Q')) then
        return true;
      end if;
      exit;
    end loop;
  end loop;
  return false;
end;
$$;

create or replace function public.ns_chess_board_fen(
  p_board jsonb,
  p_turn text,
  p_castling text,
  p_ep text,
  p_halfmove integer,
  p_fullmove integer
)
returns text
language plpgsql immutable
as $$
declare
  rank_index integer;
  file_index integer;
  empty_count integer;
  piece text;
  row_text text := '';
begin
  for rank_index in reverse 1..8 loop
    if rank_index < 8 then row_text := row_text || '/'; end if;
    empty_count := 0;
    for file_index in 1..8 loop
      piece := p_board ->> public.ns_chess_square(file_index, rank_index);
      if piece is null then
        empty_count := empty_count + 1;
      else
        if empty_count > 0 then row_text := row_text || empty_count::text; empty_count := 0; end if;
        row_text := row_text || piece;
      end if;
    end loop;
    if empty_count > 0 then row_text := row_text || empty_count::text; end if;
  end loop;
  return row_text || ' ' || p_turn || ' ' || coalesce(nullif(p_castling, ''), '-') || ' ' || coalesce(nullif(p_ep, ''), '-') || ' ' || p_halfmove::text || ' ' || p_fullmove::text;
end;
$$;

create or replace function public.ns_chess_apply_move(p_fen text, p_uci text)
returns jsonb
language plpgsql
as $$
declare
  state jsonb := public.ns_chess_parse_fen(p_fen);
  board jsonb := state -> 'board';
  from_square text := lower(substr(trim(p_uci), 1, 2));
  to_square text := lower(substr(trim(p_uci), 3, 2));
  promotion text := nullif(lower(substr(trim(p_uci), 5, 1)), '');
  piece text := board ->> from_square;
  target_piece text := board ->> to_square;
  color text;
  opponent text;
  from_file integer;
  from_rank integer;
  to_file integer;
  to_rank integer;
  file_delta integer;
  rank_delta integer;
  direction integer;
  capture_square text := to_square;
  rook_from text;
  rook_to text;
  intermediate_square text;
  moved_piece text;
  castling text := state ->> 'castling';
  ep_square text := state ->> 'ep';
  next_ep text := '-';
  halfmove integer := (state ->> 'halfmove')::integer;
  fullmove integer := (state ->> 'fullmove')::integer;
  king_square text;
  next_turn text;
begin
  if trim(coalesce(p_uci, '')) !~ '^[a-h][1-8][a-h][1-8][qrbn]?$' then raise exception 'Move notation is invalid'; end if;
  if from_square = to_square then raise exception 'Move must change squares'; end if;
  if piece is null then raise exception 'Source square is empty'; end if;
  color := public.ns_chess_piece_color(piece);
  opponent := case when color = 'w' then 'b' else 'w' end;
  if color <> state ->> 'turn' then raise exception 'It is not this side''s turn'; end if;
  if target_piece is not null and public.ns_chess_piece_color(target_piece) = color then raise exception 'A move cannot capture a friendly piece'; end if;
  if target_piece is not null and upper(target_piece) = 'K' then raise exception 'A king cannot be captured'; end if;
  from_file := public.ns_chess_square_file(from_square); from_rank := public.ns_chess_square_rank(from_square);
  to_file := public.ns_chess_square_file(to_square); to_rank := public.ns_chess_square_rank(to_square);
  file_delta := to_file - from_file; rank_delta := to_rank - from_rank;

  if upper(piece) = 'P' then
    direction := case when color = 'w' then 1 else -1 end;
    if file_delta = 0 and target_piece is null and rank_delta = direction then
      null;
    elsif file_delta = 0 and target_piece is null and rank_delta = 2 * direction
      and from_rank = (case when color = 'w' then 2 else 7 end)
      and board ->> public.ns_chess_square(from_file, from_rank + direction) is null then
      next_ep := public.ns_chess_square(from_file, from_rank + direction);
    elsif abs(file_delta) = 1 and rank_delta = direction then
      if target_piece is null then
        if ep_square <> to_square then raise exception 'Pawn capture is invalid'; end if;
        capture_square := public.ns_chess_square(to_file, from_rank);
        if (board ->> capture_square) <> (case when color = 'w' then 'p' else 'P' end) then raise exception 'En-passant capture is invalid'; end if;
        board := board - capture_square;
      end if;
    else
      raise exception 'Pawn move is invalid';
    end if;
    if to_rank = (case when color = 'w' then 8 else 1 end) and promotion is null then raise exception 'Promotion piece is required'; end if;
    if to_rank <> (case when color = 'w' then 8 else 1 end) and promotion is not null then raise exception 'Unexpected promotion piece'; end if;
  elsif upper(piece) = 'N' then
    if not (abs(file_delta) = 1 and abs(rank_delta) = 2 or abs(file_delta) = 2 and abs(rank_delta) = 1) then raise exception 'Knight move is invalid'; end if;
  elsif upper(piece) in ('B', 'R', 'Q') then
    if upper(piece) = 'B' and abs(file_delta) <> abs(rank_delta) then raise exception 'Bishop move is invalid'; end if;
    if upper(piece) = 'R' and file_delta <> 0 and rank_delta <> 0 then raise exception 'Rook move is invalid'; end if;
    if upper(piece) = 'Q' and not (file_delta = 0 or rank_delta = 0 or abs(file_delta) = abs(rank_delta)) then raise exception 'Queen move is invalid'; end if;
    if not public.ns_chess_path_clear(board, from_square, to_square) then raise exception 'A piece blocks this move'; end if;
  elsif upper(piece) = 'K' then
    if abs(file_delta) <= 1 and abs(rank_delta) <= 1 then
      null;
    elsif rank_delta = 0 and abs(file_delta) = 2 then
      if color = 'w' and from_square <> 'e1' then raise exception 'Castling origin is invalid'; end if;
      if color = 'b' and from_square <> 'e8' then raise exception 'Castling origin is invalid'; end if;
      if (color = 'w' and to_square not in ('g1', 'c1'))
         or (color = 'b' and to_square not in ('g8', 'c8')) then
        raise exception 'Castling destination is invalid';
      end if;
      if to_file > from_file and strpos(coalesce(nullif(castling, '-'), ''), case when color = 'w' then 'K' else 'k' end) = 0 then raise exception 'Kingside castling is unavailable'; end if;
      if to_file < from_file and strpos(coalesce(nullif(castling, '-'), ''), case when color = 'w' then 'Q' else 'q' end) = 0 then raise exception 'Queenside castling is unavailable'; end if;
      rook_from := case when to_file > from_file then (case when color = 'w' then 'h1' else 'h8' end) else (case when color = 'w' then 'a1' else 'a8' end) end;
      rook_to := case when to_file > from_file then public.ns_chess_square(to_file - 1, from_rank) else public.ns_chess_square(to_file + 1, from_rank) end;
      if public.ns_chess_is_attacked(board, from_square, opponent) then raise exception 'Cannot castle out of check'; end if;
      if (board ->> rook_from) <> (case when color = 'w' then 'R' else 'r' end) then raise exception 'Castling rook is missing'; end if;
      if not public.ns_chess_path_clear(board, from_square, rook_from) then raise exception 'Castling path is blocked'; end if;
      intermediate_square := public.ns_chess_square(from_file + sign(file_delta), from_rank);
      if public.ns_chess_is_attacked((board - from_square) || jsonb_build_object(intermediate_square, piece), intermediate_square, opponent) then raise exception 'Cannot castle through check'; end if;
      board := board - rook_from || jsonb_build_object(rook_to, board ->> rook_from);
      castling := '-';
    else
      raise exception 'King move is invalid';
    end if;
  else
    raise exception 'Piece is invalid';
  end if;

  board := board - from_square - to_square;
  moved_piece := case when promotion is null then piece else case when color = 'w' then upper(promotion) else lower(promotion) end end;
  board := board || jsonb_build_object(to_square, moved_piece);

  if upper(piece) = 'K' then
    if color = 'w' then castling := replace(replace(castling, 'K', ''), 'Q', ''); else castling := replace(replace(castling, 'k', ''), 'q', ''); end if;
  elsif upper(piece) = 'R' then
    if from_square = 'a1' then castling := replace(castling, 'Q', ''); elsif from_square = 'h1' then castling := replace(castling, 'K', ''); elsif from_square = 'a8' then castling := replace(castling, 'q', ''); elsif from_square = 'h8' then castling := replace(castling, 'k', ''); end if;
  end if;
  if target_piece is not null and upper(target_piece) = 'R' then
    if to_square = 'a1' then castling := replace(castling, 'Q', ''); elsif to_square = 'h1' then castling := replace(castling, 'K', ''); elsif to_square = 'a8' then castling := replace(castling, 'q', ''); elsif to_square = 'h8' then castling := replace(castling, 'k', ''); end if;
  end if;
  if castling = '' then castling := '-'; end if;
  if upper(piece) = 'P' or target_piece is not null or capture_square <> to_square then halfmove := 0; else halfmove := halfmove + 1; end if;
  if color = 'b' then fullmove := fullmove + 1; end if;
  next_turn := opponent;
  king_square := public.ns_chess_find_king(board, color);
  if king_square is null or public.ns_chess_is_attacked(board, king_square, opponent) then raise exception 'Move leaves king in check'; end if;
  return jsonb_build_object(
    'fen', public.ns_chess_board_fen(board, next_turn, castling, next_ep, halfmove, fullmove),
    'board', board,
    'turn', next_turn,
    'castling', castling,
    'ep', next_ep,
    'halfmove', halfmove,
    'fullmove', fullmove
  );
end;
$$;

create or replace function public.ns_chess_try_move(p_fen text, p_uci text)
returns boolean
language plpgsql
as $$
begin
  perform public.ns_chess_apply_move(p_fen, p_uci);
  return true;
exception when others then
  return false;
end;
$$;

create or replace function public.ns_chess_position_status(p_fen text)
returns text
language plpgsql
as $$
declare
  state jsonb := public.ns_chess_parse_fen(p_fen);
  board jsonb := state -> 'board';
  turn text := state ->> 'turn';
  king text := public.ns_chess_find_king(board, turn);
  from_file integer;
  from_rank integer;
  to_file integer;
  to_rank integer;
  from_square text;
  to_square text;
  piece text;
  promotion text;
begin
  for from_file in 1..8 loop
    for from_rank in 1..8 loop
      from_square := public.ns_chess_square(from_file, from_rank);
      piece := board ->> from_square;
      if piece is null or public.ns_chess_piece_color(piece) <> turn then continue; end if;
      for to_file in 1..8 loop
        for to_rank in 1..8 loop
          to_square := public.ns_chess_square(to_file, to_rank);
          if upper(piece) = 'P' and to_rank = (case when turn = 'w' then 8 else 1 end) then
            foreach promotion in array ARRAY['q', 'r', 'b', 'n'] loop
              if public.ns_chess_try_move(p_fen, from_square || to_square || promotion) then return 'active'; end if;
            end loop;
          elsif public.ns_chess_try_move(p_fen, from_square || to_square) then
            return 'active';
          end if;
        end loop;
      end loop;
    end loop;
  end loop;
  if public.ns_chess_is_attacked(board, king, case when turn = 'w' then 'b' else 'w' end) then
    return 'checkmate';
  end if;
  return 'stalemate';
end;
$$;

create or replace function public.ns_chess_insufficient_material(p_fen text)
returns boolean
language plpgsql
as $$
declare
  board jsonb := public.ns_chess_parse_fen(p_fen) -> 'board';
  non_king integer := 0;
  piece text;
  square text;
  piece_record record;
  bishop_colors text[] := '{}';
begin
  for piece_record in select key, value from jsonb_each_text(board) loop
    square := piece_record.key;
    piece := piece_record.value;
    if upper(piece) = 'K' then continue; end if;
    if upper(piece) in ('P', 'R', 'Q') then return false; end if;
    non_king := non_king + 1;
    if upper(piece) = 'B' then
      bishop_colors := array_append(bishop_colors, case when (public.ns_chess_square_file(square) + public.ns_chess_square_rank(square)) % 2 = 0 then 'light' else 'dark' end);
    elsif upper(piece) <> 'N' then
      return false;
    end if;
  end loop;
  if non_king = 0 then return true; end if;
  if non_king = 1 then return true; end if;
  if non_king = 2 and cardinality(bishop_colors) = 2 and bishop_colors[1] = bishop_colors[2] then return true; end if;
  return false;
end;
$$;

create or replace function public.ns_chess_threefold_repetition(p_moves jsonb)
returns boolean
language plpgsql
as $$
declare
  state_fen text := 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  position_key text;
  move_item text;
  seen_positions text[] := array[]::text[];
  prior_count integer;
  applied jsonb;
begin
  position_key := split_part(state_fen, ' ', 1) || ' ' || split_part(state_fen, ' ', 2) || ' ' || split_part(state_fen, ' ', 3) || ' ' || split_part(state_fen, ' ', 4);
  seen_positions := array_append(seen_positions, position_key);
  for move_item in select value from jsonb_array_elements_text(coalesce(p_moves, '[]'::jsonb)) as item(value) loop
    if move_item !~ '^[a-h][1-8][a-h][1-8][qrbn]?$' then continue; end if;
    applied := public.ns_chess_apply_move(state_fen, move_item);
    state_fen := applied ->> 'fen';
    position_key := split_part(state_fen, ' ', 1) || ' ' || split_part(state_fen, ' ', 2) || ' ' || split_part(state_fen, ' ', 3) || ' ' || split_part(state_fen, ' ', 4);
    select count(*) into prior_count from unnest(seen_positions) as previous(value) where previous.value = position_key;
    if prior_count >= 2 then return true; end if;
    seen_positions := array_append(seen_positions, position_key);
  end loop;
  return false;
end;
$$;

-- Chess helpers are implementation details of the move RPC, not public RPCs.
revoke all on function public.ns_chess_square_file(text) from public;
revoke all on function public.ns_chess_square_rank(text) from public;
revoke all on function public.ns_chess_square(integer, integer) from public;
revoke all on function public.ns_chess_piece_color(text) from public;
revoke all on function public.ns_chess_parse_fen(text) from public;
revoke all on function public.ns_chess_path_clear(jsonb, text, text) from public;
revoke all on function public.ns_chess_find_king(jsonb, text) from public;
revoke all on function public.ns_chess_is_attacked(jsonb, text, text) from public;
revoke all on function public.ns_chess_board_fen(jsonb, text, text, text, integer, integer) from public;
revoke all on function public.ns_chess_apply_move(text, text) from public;
revoke all on function public.ns_chess_try_move(text, text) from public;
revoke all on function public.ns_chess_position_status(text) from public;
revoke all on function public.ns_chess_insufficient_material(text) from public;
revoke all on function public.ns_chess_threefold_repetition(jsonb) from public;

-- A fresh move is accepted only when the server computes exactly the FEN the
-- client submitted.  This prevents forged board state and illegal UCI moves.
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
  existing_count integer;
  submitted_count integer;
  move_index integer;
  new_item text;
  active_draw_offer text := '';
  completion_result text;
  applied jsonb;
  terminal_state text;
  elapsed_ms bigint;
  remaining_ms bigint;
begin
  if current_user_id is null then raise exception 'Sign in to save a friend game'; end if;
  perform public.expire_game_challenges();
  select * into found from public.game_challenges where code = upper(trim(p_code)) for update;
  if found.id is null then raise exception 'Challenge not found'; end if;
  if current_user_id <> found.creator_id and current_user_id <> found.opponent_id then raise exception 'You are not in this game'; end if;
  if found.status <> 'active' then raise exception 'This challenge is not ready to play'; end if;
  if p_expected_revision is not null and p_expected_revision <> found.revision then raise exception 'This game changed on another device. Reconnecting...' using errcode = '40001'; end if;
  if jsonb_typeof(coalesce(p_moves, '[]'::jsonb)) <> 'array' or length(coalesce(p_fen, '')) < 8 or length(p_fen) > 256 then raise exception 'Game state is invalid'; end if;
  existing_count := jsonb_array_length(found.moves);
  submitted_count := jsonb_array_length(p_moves);
  if submitted_count < existing_count or submitted_count > existing_count + 1 then raise exception 'Game history must advance one action at a time'; end if;
  if existing_count > 0 then
    for move_index in 0..existing_count - 1 loop
      if found.moves -> move_index is distinct from p_moves -> move_index then raise exception 'Game history changed on another device. Reconnecting...' using errcode = '40001'; end if;
      new_item := found.moves ->> move_index;
      if new_item ~ '^__draw_offer:[wb]$' then active_draw_offer := new_item; elsif new_item in ('__draw_decline', '__draw_accept') then active_draw_offer := ''; end if;
    end loop;
  end if;
  if submitted_count = existing_count then
    if p_fen <> found.fen or p_status <> 'active' or p_move_applied then raise exception 'Game update did not contain a new action'; end if;
    return public.challenge_payload(found);
  end if;
  new_item := p_moves ->> existing_count;
  actor_color := case when current_user_id = found.creator_id then found.creator_color else case when found.creator_color = 'w' then 'b' else 'w' end end;

  if new_item ~ '^[a-h][1-8][a-h][1-8][qrbn]?$' then
    if not p_move_applied or p_status not in ('active', 'completed') then raise exception 'A board move must be submitted as an active turn'; end if;
    active_user_id := case when found.active_color = found.creator_color then found.creator_id else found.opponent_id end;
    if active_user_id is distinct from current_user_id then raise exception 'It is not your turn'; end if;
    applied := public.ns_chess_apply_move(found.fen, new_item);
    if applied ->> 'fen' <> p_fen then raise exception 'Server position does not match the submitted move'; end if;
    if found.clock <> 'none' then
      elapsed_ms := greatest(0, floor(extract(epoch from now() - coalesce(found.turn_started_at, now())) * 1000));
      remaining_ms := case when found.active_color = 'w' then greatest(0, found.white_ms - elapsed_ms) else greatest(0, found.black_ms - elapsed_ms) end;
      if remaining_ms = 0 then
        update public.game_challenges set white_ms = case when found.active_color = 'w' then 0 else white_ms end, black_ms = case when found.active_color = 'b' then 0 else black_ms end, revision = revision + 1, updated_at = now() where id = found.id returning * into found;
        select * into found from public.finalize_game_challenge(found.id, case when found.active_color = 'w' then 'black' else 'white' end, 'timeout');
        return public.challenge_payload(found);
      end if;
      update public.game_challenges set white_ms = case when found.active_color = 'w' then remaining_ms + increment_ms else white_ms end, black_ms = case when found.active_color = 'b' then remaining_ms + increment_ms else black_ms end, active_color = case when found.active_color = 'w' then 'b' else 'w' end, turn_started_at = now(), fen = p_fen, moves = p_moves, revision = revision + 1, updated_at = now() where id = found.id returning * into found;
    else
      update public.game_challenges set active_color = case when found.active_color = 'w' then 'b' else 'w' end, fen = p_fen, moves = p_moves, revision = revision + 1, updated_at = now() where id = found.id returning * into found;
    end if;
    if p_status = 'completed' then
      terminal_state := public.ns_chess_position_status(p_fen);
      if terminal_state = 'checkmate' then completion_result := case when (applied ->> 'turn') = 'w' then 'black' else 'white' end;
      elsif terminal_state = 'stalemate' then completion_result := 'draw';
      else raise exception 'The submitted position is not terminal';
      end if;
      select * into found from public.finalize_game_challenge(found.id, completion_result, terminal_state);
    end if;
    return public.challenge_payload(found);
  end if;

  if p_fen <> found.fen or p_move_applied then raise exception 'Only a legal board move may change the position'; end if;
  if new_item ~ '^__draw_offer:[wb]$' then
    if p_status <> 'active' or split_part(new_item, ':', 2) <> actor_color then raise exception 'Draw offer is invalid'; end if;
  elsif new_item = '__draw_decline' then
    if p_status <> 'active' or active_draw_offer = '' or split_part(active_draw_offer, ':', 2) = actor_color then raise exception 'There is no draw offer to decline'; end if;
  elsif new_item = '__draw_accept' then
    if p_status <> 'completed' or active_draw_offer = '' or split_part(active_draw_offer, ':', 2) = actor_color then raise exception 'There is no draw offer to accept'; end if;
    completion_result := 'draw';
  elsif new_item ~ '^__resign:[wb]$' then
    if p_status <> 'completed' or split_part(new_item, ':', 2) <> actor_color then raise exception 'Resignation is invalid'; end if;
    completion_result := case when actor_color = 'w' then 'black' else 'white' end;
  elsif new_item = '__abort' then
    if p_status <> 'completed' then raise exception 'Abort is invalid'; end if;
    completion_result := 'aborted';
  elsif new_item ~ '^__result:(white|black|draw|aborted):[a-z_]+$' then
    if p_status <> 'completed' then raise exception 'Game result is invalid'; end if;
    terminal_state := public.ns_chess_position_status(found.fen);
    if split_part(new_item, ':', 2) in ('white', 'black') then
      if terminal_state <> 'checkmate'
          or split_part(new_item, ':', 2) <> (case when (public.ns_chess_parse_fen(found.fen) ->> 'turn') = 'w' then 'black' else 'white' end) then
        raise exception 'Checkmate result is not server-confirmed';
      end if;
    elsif split_part(new_item, ':', 2) = 'draw' then
      if terminal_state <> 'stalemate'
         and (public.ns_chess_parse_fen(found.fen) ->> 'halfmove')::integer < 100
         and not public.ns_chess_insufficient_material(found.fen) then
        if not public.ns_chess_threefold_repetition(found.moves) then
          raise exception 'Draw result is not server-confirmed';
        end if;
      end if;
    elsif split_part(new_item, ':', 2) <> 'aborted' then
      raise exception 'Game result is invalid';
    end if;
    completion_result := split_part(new_item, ':', 2);
  else
    raise exception 'Client-supplied result actions are not accepted';
  end if;

  update public.game_challenges set moves = p_moves, revision = revision + 1, updated_at = now() where id = found.id returning * into found;
  if p_status = 'completed' then select * into found from public.finalize_game_challenge(found.id, completion_result, case when completion_result = 'draw' then 'draw agreement' when completion_result = 'aborted' then 'aborted' else 'resignation' end); end if;
  return public.challenge_payload(found);
end;
$$;

revoke all on function public.save_game_challenge_position(text, text, jsonb, text, boolean, bigint) from public;
grant execute on function public.save_game_challenge_position(text, text, jsonb, text, boolean, bigint) to authenticated;

create or replace function public.report_tournament_result(p_pairing_id uuid, p_result text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  pairing public.tournament_pairings;
  challenge public.game_challenges;
  event public.tournaments;
  event_id uuid;
begin
  select * into pairing from public.tournament_pairings where id = p_pairing_id for update;
  if pairing.id is null or current_user_id not in (pairing.white_id, pairing.black_id) then raise exception 'Tournament pairing not found'; end if;
  if pairing.status <> 'active' then return public.get_tournament((select code from public.tournaments where id = pairing.tournament_id)); end if;
  select * into challenge from public.game_challenges where id = pairing.challenge_id for update;
  if challenge.id is null or challenge.status <> 'completed' or challenge.result not in ('white', 'black', 'draw', 'aborted') then raise exception 'The tournament game is not server-finalized'; end if;
  if p_result is not null and p_result <> challenge.result then raise exception 'Tournament result does not match the server game result'; end if;
  event_id := public.settle_tournament_pairing(pairing.id, challenge.result, challenge.termination);
  select * into event from public.tournaments where id = event_id;
  return public.get_tournament(event.code);
end;
$$;

revoke all on function public.report_tournament_result(uuid, text) from public;
grant execute on function public.report_tournament_result(uuid, text) to authenticated;

commit;
