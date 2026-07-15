# Puzzle Import Validation Report

- Source: `data/lichess_db_puzzle.csv`
- Output: `data/puzzles.json`
- CSV records inspected: 2026
- Total puzzles imported: 500
- Skipped invalid puzzles: 0
- Skipped duplicates: 0

## Puzzles Per Difficulty

| Difficulty | Rating range | Imported |
| --- | --- | ---: |
| Beginner | 400-999 | 100 |
| Intermediate | 1000-1599 | 100 |
| Advanced | 1600-1999 | 100 |
| Expert | 2000-2399 | 100 |
| Master | 2400+ | 100 |

## Import Checks

- Unique `PuzzleId` values: 500
- Unique FEN positions (board, turn, castling, en passant): 500
- Structural FEN checks: six fields, valid board geometry, one king per side, non-adjacent kings, valid active color/castling/en-passant fields, and no pawns on the first or eighth rank.
- UCI checks: every retained move matches long algebraic UCI notation and every sequence has an initial Lichess game move plus at least one puzzle continuation.
- Lichess puzzle lines are retained exactly as supplied. `primer: true` identifies Lichess's initial opponent move so the existing chess.js trainer starts on the solver's turn.

## Skip Breakdown

| Reason | Count |
| --- | ---: |
| Invalid FEN | 0 |
| Invalid UCI sequence | 0 |
| Invalid rating | 0 |
| Missing themes | 0 |
| Duplicate PuzzleId | 0 |
| Duplicate FEN | 0 |
