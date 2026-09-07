# Third-party source and license manifest

This manifest accompanies the release notices. It identifies the copyleft artifacts that require corresponding-source and license handling. It is an operational release record, not a legal opinion.

## Stockfish.js 16

- Runtime artifacts: `assets/stockfish/stockfish-nnue-16-single.js` and `assets/stockfish/stockfish-nnue-16-single.wasm`
- License identified by the local JavaScript header: GPLv3
- Upstream project: [nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js)
- Upstream Stockfish project: [official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish)
- JavaScript SHA-256: `8DAED7A71AAEE09C38956E8A99DB1F2430334218937E76A48ED3B905C5B3560E`
- WASM SHA-256: `A7ACF7F20CB81D755B39B3DD42A4BDFD6E8C8D3D203D9FBDC525E40E1F68DF08`
- Corresponding-source verification record: [`docs/STOCKFISH-CORRESPONDING-SOURCE.md`](STOCKFISH-CORRESPONDING-SOURCE.md)

Before distribution, retain the exact corresponding source/build inputs for these artifact hashes, include the applicable GPLv3 text, preserve all upstream copyright notices, and provide a valid written source offer or source package to recipients. The repository currently records the upstream source lineage but does not claim that the binary can be rebuilt from this checkout alone.

## Active copyleft piece themes

- `cburnett`, `merida`: GPLv2+ per the per-theme ledger.
- `pixel`, `pirouetti`, `letter`: AGPLv3+ per the per-theme ledger.
- The full AGPLv3 text retained for the Lichess provenance review is [`assets/pieces/LICENSE.lila`](../assets/pieces/LICENSE.lila).
- Official license references: [GNU GPLv2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html), [GNU GPLv3](https://www.gnu.org/licenses/gpl-3.0.html), and [GNU AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html).
- Per-theme provenance and upstream references are in [`docs/ASSET-LICENSE-LEDGER.md`](ASSET-LICENSE-LEDGER.md).

Before distribution, preserve each theme's copyright notice, applicable license text, source/provenance reference, and any corresponding-source obligations. Do not treat `LICENSE.lila` as a blanket license for unrelated themes.

## Release gate

- [ ] Attach or publish the exact Stockfish corresponding source/source offer for the hashes above. The immutable package correspondence and verification record are documented in `docs/STOCKFISH-CORRESPONDING-SOURCE.md`, but the release archive or a valid written offer is not mirrored in this repository.
- [x] Attach the applicable GPLv2/GPLv3/AGPLv3 license texts and per-theme notices in `docs/licenses/`.
- [x] Verify the final distribution still contains only the approved active piece themes; final clean-build verification remains a release check.
