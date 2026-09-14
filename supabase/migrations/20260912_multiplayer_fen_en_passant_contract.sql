-- Keep the server-authoritative FEN contract aligned with the bundled
-- chess.js 1.0 client. chess.js serializes an en-passant target only when
-- the side to move has a legal capture; the prior serializer emitted every
-- double-pawn target and made the locked move RPC reject legal client moves.

begin;

create or replace function public.ns_chess_en_passant_capture_is_legal(
  p_board jsonb,
  p_turn text,
  p_ep text
)
returns boolean
language plpgsql immutable
as $$
declare
  ep_file integer;
  ep_rank integer;
  direction integer;
  source_rank integer;
  file_delta integer;
  source_square text;
  captured_square text;
  pawn_piece text;
  captured_pawn text;
  opponent_color text;
  candidate_board jsonb;
  king_square text;
begin
  if p_turn not in ('w', 'b') or coalesce(p_ep, '-') !~ '^[a-h][36]$' then return false; end if;

  ep_file := public.ns_chess_square_file(p_ep);
  ep_rank := public.ns_chess_square_rank(p_ep);
  direction := case when p_turn = 'w' then 1 else -1 end;
  source_rank := ep_rank - direction;
  pawn_piece := case when p_turn = 'w' then 'P' else 'p' end;
  captured_pawn := case when p_turn = 'w' then 'p' else 'P' end;
  opponent_color := case when p_turn = 'w' then 'b' else 'w' end;
  captured_square := public.ns_chess_square(ep_file, source_rank);

  -- `->>` returns NULL for an empty square. A regular `<>` comparison then
  -- evaluates to NULL, which does not enter an IF branch in PL/pgSQL and
  -- would incorrectly admit a phantom en-passant capture. Both the captured
  -- pawn and the actual capturing pawn must exist on their exact squares.
  if (p_board ->> captured_square) is distinct from captured_pawn then return false; end if;

  for file_delta in select unnest(array[-1, 1]) loop
    source_square := public.ns_chess_square(ep_file + file_delta, source_rank);
    if source_square is null or (p_board ->> source_square) is distinct from pawn_piece then continue; end if;
    candidate_board := (p_board - source_square - captured_square) || jsonb_build_object(p_ep, pawn_piece);
    king_square := public.ns_chess_find_king(candidate_board, p_turn);
    if king_square is not null and not public.ns_chess_is_attacked(candidate_board, king_square, opponent_color) then
      return true;
    end if;
  end loop;

  return false;
end;
$$;

-- ns_chess_apply_move remains the locked legal-move authority from the
-- security hardening migration. Its FEN serialization reaches this function,
-- so canonicalizing here changes no validation, authorization, or revision
-- behavior—only the exposed fourth FEN field.
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
  canonical_ep text := coalesce(nullif(p_ep, ''), '-');
begin
  if canonical_ep <> '-' and not public.ns_chess_en_passant_capture_is_legal(p_board, p_turn, canonical_ep) then
    canonical_ep := '-';
  end if;
  for rank_index in reverse 8..1 loop
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
  return row_text || ' ' || p_turn || ' ' || coalesce(nullif(p_castling, ''), '-') || ' ' || canonical_ep || ' ' || p_halfmove::text || ' ' || p_fullmove::text;
end;
$$;

revoke all on function public.ns_chess_en_passant_capture_is_legal(jsonb, text, text) from public;
revoke all on function public.ns_chess_board_fen(jsonb, text, text, text, integer, integer) from public;

commit;
