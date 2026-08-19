# Nschess Piano Music Collection

The Store collection contains five locally bundled, secular instrumental recordings. Each exact FMA track page was checked on 2026-08-19; all five pages identify the recording as licensed under the **CC0 1.0 Universal License**. The FMA metadata also identifies these recordings as piano/instrumental, with no vocals or religious themes. Audio is bundled in `assets/audio/` so playback does not depend on a remote request.

| Store name | Original track | Creator | Duration | Tier / price | Official source | Exact license |
| --- | --- | --- | ---: | --- | --- | --- |
| Quiet Calculation | Whispered | Ondrosik | 02:30 | Common · 70 coins | [Free Music Archive](https://freemusicarchive.org/music/Ondrosik/whispered/whispered/) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) |
| Rising Position | breakthrough version 2025 | Ondrosik | 03:20 | Rare · 135 coins | [Free Music Archive](https://freemusicarchive.org/music/Ondrosik/whispered/breakthrough-version-2025/) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) |
| Midnight Strategy | ondrik and Ivanka | Ondrosik | 03:38 | Epic · 210 coins | [Free Music Archive](https://freemusicarchive.org/music/Ondrosik/whispered/ondrik-and-ivanka/) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) |
| Beyond the Board | Beyond (Piano Edit) | Pablo Perez | 04:26 | Epic · 290 coins | [Free Music Archive](https://freemusicarchive.org/music/pablo-perez/single/beyond-piano-edit/) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) |
| The Subtle Triumph | The Subtle Triumph | Patrick Davies | 04:47 | Divine · 480 coins | [Free Music Archive](https://freemusicarchive.org/music/patrick-davies/single/the-subtle-triumph/) | [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) |

The Store sells access to a cosmetic/equipped ambience preference, not a standalone redistribution of the recordings. Legacy synthetic music and sound-effect packs remain available only to the existing game/settings audio system; they are intentionally absent from the Store catalog.

Authenticated Store deployments should apply `supabase/migrations/20260819_premium_piano_store.sql` before shipping the new client. That migration replaces the former three-track catalog rows with these five active tracks and preserves existing inventory history while retiring the old Store exposure.
