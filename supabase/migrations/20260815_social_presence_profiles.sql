-- Social presence, searchable public profiles, and live profile actions.
-- Apply after the 20260812 social/messaging/activity migrations.
-- This migration is additive and keeps the existing one-argument RPCs intact.

alter table public.profiles
  add column if not exists rapid_rating integer,
  add column if not exists blitz_rating integer,
  add column if not exists bullet_rating integer,
  add column if not exists favorite_opening text,
  add column if not exists display_name text;

update public.profiles
set rapid_rating = coalesce(rapid_rating, rating),
    blitz_rating = coalesce(blitz_rating, rating),
    bullet_rating = coalesce(bullet_rating, rating),
    favorite_opening = coalesce(favorite_opening, ''),
    display_name = coalesce(nullif(display_name, ''), username);

alter table public.profiles
  alter column rapid_rating set default 450,
  alter column blitz_rating set default 450,
  alter column bullet_rating set default 450,
  alter column favorite_opening set default '',
  alter column display_name set default '';

alter table public.profiles
  alter column rapid_rating set not null,
  alter column blitz_rating set not null,
  alter column bullet_rating set not null,
  alter column favorite_opening set not null,
  alter column display_name set not null;

alter table public.profiles
  drop constraint if exists profiles_rapid_rating_check,
  drop constraint if exists profiles_blitz_rating_check,
  drop constraint if exists profiles_bullet_rating_check;
alter table public.profiles
  add constraint profiles_rapid_rating_check check (rapid_rating between 400 and 3000),
  add constraint profiles_blitz_rating_check check (blitz_rating between 400 and 3000),
  add constraint profiles_bullet_rating_check check (bullet_rating between 400 and 3000);

alter table public.friend_presence
  add column if not exists presence_status text;
update public.friend_presence
set presence_status = case when connected then 'online' else 'offline' end
where presence_status is null
   or presence_status not in ('online', 'in_game', 'looking', 'idle', 'offline');
alter table public.friend_presence
  alter column presence_status set default 'online',
  alter column presence_status set not null;
alter table public.friend_presence
  drop constraint if exists friend_presence_status_check;
alter table public.friend_presence
  add constraint friend_presence_status_check
  check (presence_status in ('online', 'in_game', 'looking', 'idle', 'offline'));
create index if not exists friend_presence_status_idx
  on public.friend_presence (presence_status, last_seen desc);

-- A single server-authoritative presence writer. The older touch_friend_presence
-- RPC remains available for older clients and only writes the online/offline
-- state it understands.
create or replace function public.set_social_presence(
  p_status text default 'online',
  p_connected boolean default true
)
returns public.friend_presence
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_status text := lower(trim(coalesce(p_status, 'online')));
  previous_status text;
  result_row public.friend_presence;
begin
  if current_user_id is null then
    raise exception 'Sign in to update presence';
  end if;
  if normalized_status not in ('online', 'in_game', 'looking', 'idle', 'offline') then
    raise exception 'Presence status is invalid';
  end if;
  if not coalesce(p_connected, true) then
    normalized_status := 'offline';
  end if;
  select presence_status into previous_status
  from public.friend_presence
  where user_id = current_user_id;
  insert into public.friend_presence(user_id, connected, last_seen, updated_at, presence_status)
  values (current_user_id, normalized_status <> 'offline', now(), now(), normalized_status)
  on conflict (user_id) do update
    set connected = excluded.connected,
        last_seen = excluded.last_seen,
        updated_at = excluded.updated_at,
        presence_status = excluded.presence_status
  returning * into result_row;
  if normalized_status = 'online' and coalesce(previous_status, 'offline') in ('offline', 'idle') then
    begin
      perform public.record_social_activity(
        current_user_id,
        'became_online',
        'online:' || current_user_id::text || ':' || to_char(current_date, 'YYYY-MM-DD'),
        '{}'::jsonb
      );
    exception when undefined_function or check_violation then
      -- Activity feed is optional during a staged migration; presence must not fail.
      null;
    end;
  end if;
  return result_row;
end;
$$;

revoke all on function public.set_social_presence(text, boolean) from public;
grant execute on function public.set_social_presence(text, boolean) to authenticated;

-- Preserve the existing RPC while making its writes compatible with the new
-- status column. Existing clients continue to send only p_connected.
create or replace function public.touch_friend_presence(p_connected boolean default true)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  perform public.set_social_presence(case when coalesce(p_connected, true) then 'online' else 'offline' end, p_connected);
end;
$$;

revoke all on function public.touch_friend_presence(boolean) from public;
grant execute on function public.touch_friend_presence(boolean) to authenticated;

-- Extend activity types without dropping existing rows.
alter table public.social_activity drop constraint if exists social_activity_activity_type_check;
alter table public.social_activity
  add constraint social_activity_activity_type_check check (activity_type in (
    'game_started', 'game_finished', 'rating_reached', 'won_ranked_game',
    'beat_ai', 'puzzle_solved', 'lesson_completed', 'achievement_earned',
    'became_online'
  ));

create or replace function public.record_social_activity(
  p_actor_id uuid,
  p_activity_type text,
  p_dedupe_key text,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare activity_id uuid;
begin
  if p_actor_id is null then return null; end if;
  if p_activity_type not in ('game_started', 'game_finished', 'rating_reached', 'won_ranked_game', 'beat_ai', 'puzzle_solved', 'lesson_completed', 'achievement_earned', 'became_online') then
    raise exception 'Activity type is invalid';
  end if;
  if length(trim(coalesce(p_dedupe_key, ''))) < 3 or length(trim(p_dedupe_key)) > 160 then
    raise exception 'Activity key is invalid';
  end if;
  if octet_length(coalesce(p_payload, '{}'::jsonb)::text) > 1800 then
    raise exception 'Activity payload is too large';
  end if;
  insert into public.social_activity(actor_id, activity_type, dedupe_key, payload)
  values (p_actor_id, p_activity_type, left(trim(p_dedupe_key), 160), coalesce(p_payload, '{}'::jsonb))
  on conflict (actor_id, dedupe_key) do nothing
  returning id into activity_id;
  return activity_id;
end;
$$;

revoke all on function public.record_social_activity(uuid, text, text, jsonb) from public;

-- Search is an additive overload. The original search_registered_players(text)
-- remains available for older clients.
create or replace function public.search_registered_players(
  p_query text,
  p_min_rating integer,
  p_max_rating integer
)
returns table (
  public_id uuid,
  username text,
  display_name text,
  avatar text,
  country_flag text,
  rating integer,
  title text,
  last_login_at timestamptz,
  online boolean,
  presence_status text,
  last_seen_at timestamptz,
  mutual_friends_count integer
)
language plpgsql security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  query_text text := left(trim(coalesce(p_query, '')), 40);
  min_rating integer := greatest(400, least(3000, coalesce(p_min_rating, 400)));
  max_rating integer := greatest(400, least(3000, coalesce(p_max_rating, 3000)));
begin
  if current_user_id is null then raise exception 'Sign in to search players'; end if;
  if max_rating < min_rating then
    max_rating := min_rating;
  end if;
  perform public.consume_social_rate_limit('player_search', 60, 60);
  return query
  select profile.id,
    profile.username,
    profile.display_name,
    profile.avatar,
    coalesce(profile.country_flag, ''),
    profile.rating,
    profile.title,
    profile.last_login_at,
    case when coalesce(settings.online_status, 'show') = 'hide' then false
      else coalesce(presence.connected and presence.last_seen > now() - interval '75 seconds', false) end,
    case when request.status <> 'accepted' or coalesce(settings.online_status, 'show') = 'hide' then 'offline'
      else coalesce(presence.presence_status, case when presence.connected then 'online' else 'offline' end) end,
    case when request.status <> 'accepted' or coalesce(settings.online_status, 'show') = 'hide' then null else presence.last_seen end,
    (
      select count(*)::integer from (
        select case when rel.sender_id = current_user_id then rel.receiver_id else rel.sender_id end as friend_id
        from public.friend_requests rel
        where rel.status = 'accepted' and (rel.sender_id = current_user_id or rel.receiver_id = current_user_id)
      ) viewer_friends
      join (
        select case when rel.sender_id = profile.id then rel.receiver_id else rel.sender_id end as friend_id
        from public.friend_requests rel
        where rel.status = 'accepted' and (rel.sender_id = profile.id or rel.receiver_id = profile.id)
      ) target_friends using (friend_id)
    )
  from public.profiles profile
  left join public.friend_presence presence on presence.user_id = profile.id
  left join public.user_privacy_settings settings on settings.user_id = profile.id
  where profile.id <> current_user_id
    and not coalesce(profile.is_bot, false)
    and profile.rating between min_rating and max_rating
    and (query_text = '' or profile.username ilike '%' || query_text || '%' or profile.display_name ilike '%' || query_text || '%')
    and coalesce(settings.profile_visibility, 'friends') <> 'private'
    and not public.is_social_blocked(current_user_id, profile.id)
  order by (case when profile.username ilike query_text then 0 else 1 end), profile.last_login_at desc nulls last, profile.username
  limit 40;
end;
$$;

revoke all on function public.search_registered_players(text, integer, integer) from public;
grant execute on function public.search_registered_players(text, integer, integer) to authenticated;

drop function if exists public.get_friend_directory();
create function public.get_friend_directory()
returns table (
  request_id uuid,
  public_id uuid,
  username text,
  display_name text,
  avatar text,
  country_flag text,
  rating integer,
  title text,
  created_at timestamptz,
  last_login_at timestamptz,
  request_status text,
  request_direction text,
  online boolean,
  presence_status text,
  last_seen_at timestamptz,
  mutual_friends_count integer
)
language sql security definer set search_path = public stable
as $$
  select request.id,
    profile.id,
    profile.username,
    profile.display_name,
    profile.avatar,
    coalesce(profile.country_flag, ''),
    profile.rating,
    profile.title,
    profile.created_at,
    profile.last_login_at,
    request.status,
    case when request.sender_id = auth.uid() then 'outgoing' else 'incoming' end,
    case when coalesce(settings.online_status, 'show') = 'hide' then false
      else request.status = 'accepted' and coalesce(presence.connected and presence.last_seen > now() - interval '75 seconds', false) end,
    case when coalesce(settings.online_status, 'show') = 'hide' then 'offline'
      else coalesce(presence.presence_status, case when presence.connected then 'online' else 'offline' end) end,
    case when coalesce(settings.online_status, 'show') = 'hide' then null else presence.last_seen end,
    0::integer
  from public.friend_requests request
  join public.profiles profile on profile.id = case when request.sender_id = auth.uid() then request.receiver_id else request.sender_id end
  left join public.friend_presence presence on presence.user_id = profile.id
  left join public.user_privacy_settings settings on settings.user_id = profile.id
  where auth.uid() is not null
    and (request.sender_id = auth.uid() or request.receiver_id = auth.uid())
    and request.status in ('pending', 'accepted')
    and not public.is_social_blocked(auth.uid(), profile.id)
  order by request.updated_at desc;
$$;

revoke all on function public.get_friend_directory() from public;
grant execute on function public.get_friend_directory() to authenticated;

create or replace function public.get_public_player_profile(p_target_user uuid)
returns jsonb
language plpgsql security definer set search_path = public stable
as $$
declare
  viewer uuid := auth.uid();
  profile_row public.profiles;
  visibility text;
  history_visibility text;
  is_friend boolean := false;
  can_private boolean := false;
  can_history boolean := false;
  can_online boolean := false;
  presence_row public.friend_presence;
  total_games integer;
  recent jsonb;
  achievements jsonb;
begin
  if viewer is null or p_target_user is null then return null; end if;
  if public.is_social_blocked(viewer, p_target_user) then return null; end if;
  select * into profile_row from public.profiles where id = p_target_user;
  if profile_row.id is null then return null; end if;
  select coalesce(settings.profile_visibility, 'friends'), coalesce(settings.match_history_visibility, 'friends')
    into visibility, history_visibility
  from public.user_privacy_settings settings where settings.user_id = p_target_user;
  is_friend := viewer = p_target_user or public.is_social_friend(viewer, p_target_user);
  can_private := viewer = p_target_user or visibility = 'public' or (visibility = 'friends' and is_friend);
  can_history := viewer = p_target_user or history_visibility = 'public' or (history_visibility = 'friends' and is_friend);
  can_online := viewer = p_target_user or public.social_online_status_allowed(viewer, p_target_user);
  select * into presence_row from public.friend_presence where user_id = p_target_user;
  total_games := coalesce(profile_row.wins, 0) + coalesce(profile_row.losses, 0) + coalesce(profile_row.draws, 0);
  if can_history then
    select coalesce(jsonb_agg(item order by item.created_at desc), '[]'::jsonb) into recent
    from (
      select activity.activity_type, activity.payload, activity.created_at
      from public.social_activity activity
      where activity.actor_id = p_target_user and activity.expires_at > now()
        and public.social_activity_visible(viewer, p_target_user)
      order by activity.created_at desc limit 8
    ) item;
  else recent := '[]'::jsonb; end if;
  if can_private then
    select coalesce(jsonb_agg(jsonb_build_object('key', earned.achievement_key, 'earnedAt', earned.earned_at) order by earned.earned_at desc), '[]'::jsonb)
      into achievements from public.player_achievements earned where earned.user_id = p_target_user;
  else achievements := '[]'::jsonb; end if;
  return jsonb_build_object(
    'id', profile_row.id,
    'publicId', profile_row.public_id,
    'username', profile_row.username,
    'displayName', profile_row.display_name,
    'avatar', profile_row.avatar,
    'country', profile_row.country_flag,
    'title', profile_row.title,
    'rating', profile_row.rating,
    'presenceStatus', case when can_online then coalesce(presence_row.presence_status, case when presence_row.connected then 'online' else 'offline' end) else 'offline' end,
    'online', can_online and coalesce(presence_row.connected and presence_row.last_seen > now() - interval '75 seconds', false),
    'lastSeen', case when can_online then presence_row.last_seen else null end,
    'private', not can_private,
    'stats', case when can_history then jsonb_build_object(
      'rapid', profile_row.rapid_rating,
      'blitz', profile_row.blitz_rating,
      'bullet', profile_row.bullet_rating,
      'gamesPlayed', total_games,
      'wins', profile_row.wins,
      'losses', profile_row.losses,
      'draws', profile_row.draws,
      'winPercentage', case when total_games > 0 then round((profile_row.wins::numeric / total_games::numeric) * 100, 1) else 0 end,
      'favoriteOpening', profile_row.favorite_opening
    ) else '{}'::jsonb end,
    'recentActivity', recent,
    'achievements', achievements,
    'joinedAt', case when can_private then profile_row.created_at else null end
  );
end;
$$;

revoke all on function public.get_public_player_profile(uuid) from public;
grant execute on function public.get_public_player_profile(uuid) to authenticated;

create or replace function public.get_active_friend_game(p_target_user uuid)
returns text
language plpgsql security definer set search_path = public stable
as $$
declare viewer uuid := auth.uid(); found_code text;
begin
  if viewer is null or p_target_user is null or viewer = p_target_user then return null; end if;
  perform public.assert_social_spectating(viewer, p_target_user);
  select challenge.code into found_code
  from public.game_challenges challenge
  where challenge.status = 'active'
    and (challenge.creator_id = p_target_user or challenge.opponent_id = p_target_user)
  order by challenge.updated_at desc
  limit 1;
  return found_code;
exception when others then
  return null;
end;
$$;

revoke all on function public.get_active_friend_game(uuid) from public;
grant execute on function public.get_active_friend_game(uuid) to authenticated;

-- Notification types are extensible, while all rows remain server-written.
alter table public.social_notifications drop constraint if exists social_notifications_type_check;
alter table public.social_notifications
  add constraint social_notifications_type_check check (type in (
    'friend_request', 'friend_accepted', 'friend_declined',
    'challenge_received', 'challenge_accepted', 'challenge_declined',
    'message_received', 'gift_received', 'game_invite',
    'spectator_joined', 'achievement_earned'
  ));

create or replace function public.notify_achievement_social_notification()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.social_notifications(recipient_id, actor_id, type, entity_id, payload)
  values (new.user_id, new.user_id, 'achievement_earned', new.user_id,
    jsonb_build_object('achievementKey', new.achievement_key, 'metadata', coalesce(new.metadata, '{}'::jsonb)));
  return new;
end;
$$;

drop trigger if exists player_achievement_social_notification on public.player_achievements;
create trigger player_achievement_social_notification
after insert on public.player_achievements
for each row execute function public.notify_achievement_social_notification();
revoke all on function public.notify_achievement_social_notification() from public;

do $$
begin
  begin
    execute 'alter publication supabase_realtime add table public.friend_presence';
  exception when duplicate_object or undefined_object then null;
  end;
end;
$$;

-- Private Presence channels are authorized by the same relationship/privacy
-- rules as the SQL directory. These policies are guarded for local databases
-- where the Realtime extension schema is not installed yet.
do $presence_policy$
begin
  begin
    execute 'drop policy if exists nschess_presence_read on realtime.messages';
    execute $sql$
      create policy nschess_presence_read on realtime.messages
      for select to authenticated
      using (
        extension = 'presence'
        and (
          realtime.topic() = 'nschess-presence:' || auth.uid()::text
          or (
            realtime.topic() ~ '^nschess-presence:[0-9a-fA-F-]{36}$'
            and public.social_online_status_allowed(auth.uid(), substring(realtime.topic() from 18)::uuid)
          )
        )
      )
    $sql$;
    execute 'drop policy if exists nschess_presence_track on realtime.messages';
    execute $sql$
      create policy nschess_presence_track on realtime.messages
      for insert to authenticated
      with check (extension = 'presence' and realtime.topic() = 'nschess-presence:' || auth.uid()::text)
    $sql$;
  exception when undefined_table or undefined_column or undefined_function or invalid_schema_name then
    null;
  end;
end;
$presence_policy$;
