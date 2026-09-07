# Stockfish.js corresponding-source record

This release record identifies the exact public source package corresponding to the Stockfish.js 16 artifacts shipped by Nschess. It is a technical source record, not legal advice. The release owner must keep the source available with the distributed notices or complete the written-offer fields below before publication.

## Release artifacts

| Local artifact | SHA-256 |
| --- | --- |
| `assets/stockfish/stockfish-nnue-16-single.js` | `8DAED7A71AAEE09C38956E8A99DB1F2430334218937E76A48ED3B905C5B3560E` |
| `assets/stockfish/stockfish-nnue-16-single.wasm` | `A7ACF7F20CB81D755B39B3DD42A4BDFD6E8C8D3D203D9FBDC525E40E1F68DF08` |

## Corresponding source

The source distribution identified for this build is the immutable npm package `stockfish@16.0.0`:

- [Immutable npm package archive](https://registry.npmjs.org/stockfish/-/stockfish-16.0.0.tgz)
- [Package directory](https://unpkg.com/stockfish@16.0.0/)
- [Stockfish.js 16 JavaScript artifact](https://unpkg.com/stockfish@16.0.0/src/stockfish-nnue-16-single.js)
- [Stockfish.js 16 WASM artifact](https://unpkg.com/stockfish@16.0.0/src/stockfish-nnue-16-single.wasm)
- [GPL/source files in the package](https://app.unpkg.com/stockfish@16.0.0/)

The package contains the source/build distribution records needed for this release line, including `Copying.txt`, `build.js`, `README.upstream.md`, `AUTHORS`, `package.json`, and the `src/` tree. The upstream projects are [nmrugg/stockfish.js](https://github.com/nmrugg/stockfish.js) and [official-stockfish/Stockfish](https://github.com/official-stockfish/Stockfish).

## Verification performed

On 2026-09-06, the package files were fetched read-only and compared with the release artifacts:

- The WASM file matched byte-for-byte.
- The JavaScript file matched after normalizing the package's LF line endings against the local CRLF line endings; the executable content and text are otherwise identical.
- The local banner identifies Stockfish.js 16, nmrugg's project, GPLv3, and the upstream Stockfish lineage.

## Publication requirement

Before publication, the release owner must either:

1. include a mirrored copy of the immutable source archive above in the release materials, or
2. publish a valid written source offer with an official licensing contact, a durable source location, the exact artifact hashes above, and the required offer period.

Do not substitute a floating repository branch or an unpinned CDN URL for the immutable package record. The package URL is recorded here for correspondence and verification; the release owner remains responsible for confirming continued availability and satisfying the applicable GPLv3 distribution terms.
