# External content and terms review record

This record separates technical inventory from human acceptance of third-party terms and rights. The links were checked during release preparation; a human owner must approve the final deployment context before publication.

## YouTube embeds and thumbnails

- Inventory: externally hosted YouTube player/embed references and `i.ytimg.com` thumbnails in `index.html`/`assets/app.js`; no video files are bundled locally.
- Product use: official embeddable player and remote thumbnails; Nschess does not redistribute the video files.
- Review sources: [YouTube Terms](https://www.youtube.com/static?template=terms) and [Google Privacy Policy](https://policies.google.com/privacy).
- Human checks: confirm each selected video/channel may be embedded, confirm the deployment's consent/privacy treatment for third-party requests, and review whether monetization or audience settings change the result.

## Google Fonts

- Inventory: Manrope and Space Grotesk loaded from `fonts.googleapis.com`.
- Technical record: the families are recorded as SIL Open Font License 1.1; current use is remote loading rather than a locally redistributed font file.
- Review source: [Google Fonts FAQ](https://fonts.google.com/faq).
- Human checks: confirm the exact family/weights, the remote-loading/privacy position, and whether the final deployment should self-host the fonts with the OFL text.

## CC0 music and uploader rights

- Inventory: five locally bundled FMA recordings documented in [`STORE-MUSIC-LICENSES.md`](STORE-MUSIC-LICENSES.md).
- Technical record: the public FMA pages currently identify each recording as CC0 1.0, and source links are preserved in the music ledger.
- Human checks: confirm the uploader had the rights to dedicate each recording to CC0, confirm no sample/performer/publisher rights remain unresolved, and confirm the intended Store/commercial use.

## Human approval

- Reviewer: ______________________________________
- Organization/title: ______________________________
- YouTube/privacy approved for this deployment:  Yes / No
- Google Fonts terms/privacy approved:  Yes / No
- Music CC0/uploader rights approved:  Yes / No
- Conditions or required mitigations: __________________________________________
- Review date and signature/recorded approval: _________________________________

Until these approvals are recorded, the external-content package remains a publication blocker even though the technical inventory and source links are present.
