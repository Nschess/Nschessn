-- Keep the server catalog in lockstep with the shared frontend Store.
-- Arrow skins are first-class cosmetics rendered by the shared board arrow
-- renderer, so they must be accepted by the authoritative catalog as well.
do $$
begin
  if to_regclass('public.store_catalog') is not null then
    alter table public.store_catalog drop constraint if exists store_catalog_item_type_check;
    alter table public.store_catalog add constraint store_catalog_item_type_check check (item_type in (
      'board', 'skin', 'pieceFinish', 'backgroundTheme', 'avatar', 'avatarEffect',
      'frame', 'nameStyle', 'lastMove', 'boardBorder', 'archetype', 'musicPack',
      'sfxPack', 'title', 'trail', 'flexBadge', 'arrowSkin'
    ));
  end if;
end;
$$;
