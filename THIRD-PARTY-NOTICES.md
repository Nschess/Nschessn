# Nschess third-party notices

This file records the third-party software and content currently used by the release candidate. It is a notice and provenance index, not a legal clearance opinion. The cited license terms and source records must remain with any distributed release, and a human licensing review is still required for unresolved items.

## Runtime software

### chess.js 1.0.0

`assets/vendor/chess.js-1.0.0.mjs` is a local copy of chess.js 1.0.0. It is distributed under the BSD-2-Clause license. The corresponding copyright, conditions, and disclaimer are preserved in [`assets/vendor/chess.js-1.0.0.LICENSE`](assets/vendor/chess.js-1.0.0.LICENSE). Upstream source and license: [jhlywa/chess.js](https://github.com/jhlywa/chess.js/blob/master/LICENSE).

### Stockfish.js 16

`assets/stockfish/stockfish-nnue-16-single.js` and `assets/stockfish/stockfish-nnue-16-single.wasm` are Stockfish.js 16 build artifacts. The local JavaScript header identifies nmrugg's Stockfish.js project and GPLv3 licensing. The immutable `stockfish@16.0.0` package correspondence and hash verification are recorded in [`docs/STOCKFISH-CORRESPONDING-SOURCE.md`](docs/STOCKFISH-CORRESPONDING-SOURCE.md) and [`docs/THIRD-PARTY-SOURCE-MANIFEST.md`](docs/THIRD-PARTY-SOURCE-MANIFEST.md). Redistribution requires preserving the applicable GPLv3 notices, license text, and corresponding-source offer.

### Lucide and Feather-derived icons

The application loads Lucide UMD 0.468.0 from `https://cdn.jsdelivr.net/npm/lucide@0.468.0/dist/umd/lucide.min.js`. Lucide is licensed under ISC; some Lucide icons derive from Feather, which is MIT licensed. Preserve the [Lucide license notice](https://github.com/lucide-icons/lucide/blob/main/LICENSE) and the applicable [Feather license](https://github.com/feathericons/feather/blob/main/LICENSE) with distributed notices.

### Supabase JavaScript client

The application references `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.115.0`. Supabase JS 2.115.0 is MIT licensed. Preserve the [Supabase license notice](https://github.com/supabase/supabase-js/blob/master/LICENSE). The runtime URL is pinned to the exact version documented here.

## Active chess-piece themes

The active selector contains the following themes. Per-theme provenance remains in [`docs/ASSET-LICENSE-LEDGER.md`](docs/ASSET-LICENSE-LEDGER.md):

- `cburnett` — GPLv2+
- `chessnut` — Apache-2.0
- `merida` — GPLv2+
- `fantasy` — MIT
- `pixel` — AGPLv3+
- `pirouetti` — AGPLv3+
- `kiwen-suwi` — CC BY 4.0; attribution required
- `kosal` — CC BY 4.0; attribution required
- `letter` — AGPLv3+
- `spatial` — MIT

The nine restricted/unresolved themes removed in Phase B and the unresolved `governor` theme are not included in the release candidate. The application retains only legacy metadata for `governor`, which resolves to the default theme and is not selectable.

## Other content and fonts

- `assets/pieces/LICENSE.lila` and [`docs/licenses/AGPL-3.0.txt`](docs/licenses/AGPL-3.0.txt) are the retained GNU AGPLv3 license texts associated with the Lichess provenance review. [`docs/licenses/GPL-2.0.txt`](docs/licenses/GPL-2.0.txt) and [`docs/licenses/GPL-3.0.txt`](docs/licenses/GPL-3.0.txt) accompany the active copyleft themes and Stockfish notice. These texts are not blanket licenses for every piece directory; per-theme obligations are in [`docs/licenses/PIECE-THEME-NOTICES.md`](docs/licenses/PIECE-THEME-NOTICES.md).
- `data/puzzles.json` is recorded as a Lichess puzzle database export under CC0; the source/version record remains in the asset ledger.
- The local music files and their source/license records are documented in [`docs/STORE-MUSIC-LICENSES.md`](docs/STORE-MUSIC-LICENSES.md); the five public FMA records were rechecked on 2026-09-06 and identify CC0 1.0.
- Manrope and Space Grotesk are loaded from Google Fonts under the SIL Open Font License 1.1; see the [Google Fonts FAQ](https://fonts.google.com/faq) and retain the applicable OFL record if fonts are self-hosted.
- YouTube embeds and thumbnails remain externally hosted content. Nschess uses the official embeddable player and does not redistribute the video files. Review the [YouTube Terms](https://www.youtube.com/static?template=terms) and [Google Privacy Policy](https://policies.google.com/privacy) for the final deployment context.

## Items requiring human release review

The coach illustration and `governor` theme are no longer shipped. The technical source and license package is attached, but exact upstream revisions for attributed piece sets, GPL/AGPL release-owner sign-off, music-source refresh/uploader rights, Google Fonts terms, YouTube/privacy terms, and final Nschess ownership attestations still require human release review.
