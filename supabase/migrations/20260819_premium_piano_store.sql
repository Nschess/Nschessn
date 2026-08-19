-- Curated Store ambience collection.
-- These five secular instrumental recordings are CC0 1.0 Universal and are
-- bundled locally by the web app. Catalog rows represent cosmetic access and
-- equip state, not a change to the separate in-game SFX system.

insert into public.store_catalog (
  item_id, item_type, name, cost_coins, rarity, unlock_method,
  giftable, active, metadata, updated_at
)
values
  (
    'music-quiet-calculation', 'musicPack', 'Quiet Calculation', 70, 'Common', 'Coins',
    true, true,
    jsonb_build_object(
      'originalTitle', 'Whispered',
      'artist', 'Ondrosik',
      'mood', 'Focus',
      'instrument', 'Piano',
      'descriptor', 'Calm',
      'durationSec', 150,
      'sourceUrl', 'https://freemusicarchive.org/music/Ondrosik/whispered/whispered/',
      'license', 'CC0 1.0 Universal',
      'licenseUrl', 'https://creativecommons.org/publicdomain/zero/1.0/',
      'audioPath', 'assets/audio/quiet-calculation.mp3'
    ), now()
  ),
  (
    'music-rising-position', 'musicPack', 'Rising Position', 135, 'Rare', 'Coins',
    true, true,
    jsonb_build_object(
      'originalTitle', 'breakthrough version 2025',
      'artist', 'Ondrosik',
      'mood', 'Uplifting',
      'instrument', 'Piano',
      'descriptor', 'Progress',
      'durationSec', 200,
      'sourceUrl', 'https://freemusicarchive.org/music/Ondrosik/whispered/breakthrough-version-2025/',
      'license', 'CC0 1.0 Universal',
      'licenseUrl', 'https://creativecommons.org/publicdomain/zero/1.0/',
      'audioPath', 'assets/audio/rising-position.mp3'
    ), now()
  ),
  (
    'music-midnight-strategy', 'musicPack', 'Midnight Strategy', 210, 'Epic', 'Coins',
    true, true,
    jsonb_build_object(
      'originalTitle', 'ondrik and Ivanka',
      'artist', 'Ondrosik',
      'mood', 'Emotional',
      'instrument', 'Piano',
      'descriptor', 'Reflective',
      'durationSec', 218,
      'sourceUrl', 'https://freemusicarchive.org/music/Ondrosik/whispered/ondrik-and-ivanka/',
      'license', 'CC0 1.0 Universal',
      'licenseUrl', 'https://creativecommons.org/publicdomain/zero/1.0/',
      'audioPath', 'assets/audio/midnight-strategy.mp3'
    ), now()
  ),
  (
    'music-beyond-the-board', 'musicPack', 'Beyond the Board', 290, 'Epic', 'Coins',
    true, true,
    jsonb_build_object(
      'originalTitle', 'Beyond (Piano Edit)',
      'artist', 'Pablo Perez',
      'mood', 'Deep Focus',
      'instrument', 'Ambient Piano',
      'descriptor', 'Immersive',
      'durationSec', 266,
      'sourceUrl', 'https://freemusicarchive.org/music/pablo-perez/single/beyond-piano-edit/',
      'license', 'CC0 1.0 Universal',
      'licenseUrl', 'https://creativecommons.org/publicdomain/zero/1.0/',
      'audioPath', 'assets/audio/beyond-the-board.mp3'
    ), now()
  ),
  (
    'music-subtle-triumph', 'musicPack', 'The Subtle Triumph', 480, 'Divine', 'Coins',
    true, true,
    jsonb_build_object(
      'originalTitle', 'The Subtle Triumph',
      'artist', 'Patrick Davies',
      'mood', 'Premium',
      'instrument', 'Piano',
      'descriptor', 'Achievement',
      'durationSec', 287,
      'sourceUrl', 'https://freemusicarchive.org/music/patrick-davies/single/the-subtle-triumph/',
      'license', 'CC0 1.0 Universal',
      'licenseUrl', 'https://creativecommons.org/publicdomain/zero/1.0/',
      'audioPath', 'assets/audio/subtle-triumph.mp3'
    ), now()
  )
on conflict (item_id) do update set
  item_type = excluded.item_type,
  name = excluded.name,
  cost_coins = excluded.cost_coins,
  rarity = excluded.rarity,
  unlock_method = excluded.unlock_method,
  giftable = excluded.giftable,
  active = true,
  metadata = excluded.metadata,
  updated_at = now();

-- Retire Store exposure for the former three-track collection, legacy
-- synthetic music, and sound-pack entries. Existing inventory rows are kept
-- for history and compatibility; only active catalog visibility is removed.
update public.store_catalog
set active = false, updated_at = now()
where item_id = any (array[
  'music-after-last-move', 'music-quiet-strategy', 'music-golden-endgame',
  'music-calm', 'music-piano', 'music-lofi', 'music-ambient', 'music-medieval',
  'music-fantasy', 'music-royal', 'music-focus', 'music-battle', 'music-jazz',
  'music-nature', 'music-space', 'music-cosmic', 'music-cyberpunk', 'music-samurai',
  'music-viking', 'music-halloween', 'music-christmas', 'music-victory',
  'music-defeat', 'music-dragon', 'sfx-classic', 'sfx-modern', 'sfx-medieval',
  'sfx-fantasy', 'sfx-minimal'
]::text[])
and item_type in ('musicPack', 'sfxPack');
