-- Realtime friend activity feed and activity privacy.
-- Apply after 20260812_messaging_privacy.sql and
-- 20260812_store_authority_gifting.sql.

alter table public.user_privacy_settings
  add column if not exists allow_spectating text;
alter table public.user_privacy_settings
  add column if not exists activity_visibility text;
alter table public.user_privacy_settings
  alter column allow_spectating set default 'friends',
  alter column activity_visibility set default 'friends';
update public.user_privacy_settings
set allow_spectating = 'friends'
where allow_spectating is null
  or allow_spectating not in ('on', 'friends', 'off');
update public.user_privacy_settings
set activity_visibility = 'friends'
where activity_visibility is null
  or activity_visibility not in ('public', 'friends', 'private');
alter table public.user_privacy_settings
  alter column allow_spectating set not null,
  alter column activity_visibility set not null;
alter table public.user_privacy_settings
  drop constraint if exists user_privacy_settings_allow_spectating_check;
alter table public.user_privacy_settings
  add constraint user_privacy_settings_allow_spectating_check
  check (allow_spectating in ('on', 'friends', 'off'));
alter table public.user_privacy_settings
  drop constraint if exists user_privacy_settings_activity_visibility_check;
alter table public.user_privacy_settings
  add constraint user_privacy_settings_activity_visibility_check
  check (activity_visibility in ('public', 'friends', 'private'));

create table if not exists public.social_activity (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete cascade,
  activity_type text not null check (activity_type in (
    'game_started', 'rating_reached', 'puzzle_solved',
    'lesson_completed', 'achievement_earned'
  )),
  dedupe_key text not null check (length(dedupe_key) between 3 and 160),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  unique (actor_id, dedupe_key)
);

create index if not exists social_activity_feed_idx
  on public.social_activity (created_at desc, id desc);
create index if not exists social_activity_actor_idx
  on public.social_activity (actor_id, created_at desc);

alter table public.social_activity enable row level security;
revoke all on table public.social_activity from anon, authenticated;
grant select on public.social_activity to authenticated;

create or replace function public.social_activity_visible(p_viewer uuid, p_actor uuid)
returns boolean
language plpgsql security definer set search_path = public stable
as $$
declare visibility text;
begin
  if p_viewer is null or p_actor is null then return false; end if;
  if p_viewer = p_actor then return true; end if;
  if public.is_social_blocked(p_viewer, p_actor) then return false; end if;
  select coalesce(settings.activity_visibility, 'friends')
    into visibility
  from public.user_privacy_settings settings
  where settings.user_id = p_actor;
  visibility := coalesce(visibility, 'friends');
  return visibility = 'public'
    or (visibility = 'friends' and public.is_social_friend(p_viewer, p_actor));
end;
$$;

drop policy if exists social_activity_visible_read on public.social_activity;
create policy social_activity_visible_read on public.social_activity
  for select to authenticated
  using (public.social_activity_visible(auth.uid(), actor_id));

-- Internal event writer. It is intentionally not executable by clients; only
-- security-definer triggers and the validated learning RPC call it.
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
  if p_activity_type not in ('game_started', 'rating_reached', 'puzzle_solved', 'lesson_completed', 'achievement_earned') then
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

-- Puzzle/lesson progress is currently local-first in the static client. The
-- RPC makes those feed writes server-owned, bounded, and idempotent while the
-- game/achievement events below remain trigger-authenticated.
create or replace function public.publish_learning_activity(
  p_activity_type text,
  p_dedupe_key text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare current_user_id uuid := auth.uid(); activity_id uuid;
begin
  if current_user_id is null then raise exception 'Sign in to share learning activity'; end if;
  if p_activity_type not in ('puzzle_solved', 'lesson_completed') then
    raise exception 'Only learning activity can be published from the client';
  end if;
  if length(trim(coalesce(p_dedupe_key, ''))) < 3 then raise exception 'Activity key is missing'; end if;
  select id into activity_id
  from public.social_activity
  where actor_id = current_user_id and dedupe_key = left(trim(p_dedupe_key), 160)
  limit 1;
  if activity_id is not null then
    return jsonb_build_object('activityId', activity_id, 'replayed', true);
  end if;
  perform public.consume_social_rate_limit('activity_publish', 80, 86400);
  activity_id := public.record_social_activity(current_user_id, p_activity_type, p_dedupe_key, p_payload);
  return jsonb_build_object('activityId', activity_id, 'replayed', false);
end;
$$;

create or replace function public.get_social_activity_feed(
  p_limit integer default 40,
  p_before timestamptz default null
)
returns table(
  id uuid,
  actor_id uuid,
  actor_username text,
  actor_avatar text,
  activity_type text,
  payload jsonb,
  created_at timestamptz
)
language sql security definer set search_path = public stable
as $$
  select activity.id,
    activity.actor_id,
    coalesce(profile.username, 'Chess player'),
    coalesce(profile.avatar, 'auto'),
    activity.activity_type,
    activity.payload,
    activity.created_at
  from public.social_activity activity
  left join public.profiles profile on profile.id = activity.actor_id
  where auth.uid() is not null
    and activity.expires_at > now()
    and (p_before is null or activity.created_at < p_before)
    and public.social_activity_visible(auth.uid(), activity.actor_id)
  order by activity.created_at desc, activity.id desc
  limit greatest(1, least(coalesce(p_limit, 40), 100));
$$;

create or replace function public.update_activity_visibility(p_visibility text)
returns public.user_privacy_settings
language plpgsql security definer set search_path = public
as $$
declare current_user_id uuid := auth.uid(); saved public.user_privacy_settings;
begin
  if current_user_id is null then raise exception 'Sign in to update privacy'; end if;
  if p_visibility not in ('public', 'friends', 'private') then raise exception 'Activity visibility is invalid'; end if;
  insert into public.user_privacy_settings(user_id, activity_visibility, updated_at)
  values (current_user_id, p_visibility, now())
  on conflict (user_id) do update set activity_visibility = excluded.activity_visibility, updated_at = now()
  returning * into saved;
  return saved;
end;
$$;

-- Replace the composite fallback after adding activity_visibility to the row
-- type. Existing callers keep the same RPC name and receive the new field.
drop function if exists public.get_user_privacy_settings();
create function public.get_user_privacy_settings()
returns public.user_privacy_settings
language sql security definer set search_path = public stable
as $$
  select coalesce(
    (select settings from public.user_privacy_settings settings where settings.user_id = auth.uid()),
    jsonb_populate_record(null::public.user_privacy_settings, jsonb_build_object(
      'user_id', auth.uid(),
      'profile_visibility', 'friends',
      'allow_friend_requests', 'on',
      'allow_challenges', 'on',
      'allow_messages', 'friends',
      'online_status', 'show',
      'match_history_visibility', 'friends',
      'allow_spectating', 'friends',
      'activity_visibility', 'friends',
      'updated_at', now()
    ))
  );
$$;

create or replace function public.notify_game_activity()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    perform public.record_social_activity(
      new.creator_id,
      'game_started',
      'challenge:' || new.id::text || ':creator',
      jsonb_build_object('challengeId', new.id, 'code', new.code, 'gameType', new.game_type, 'clock', new.clock)
    );
    if new.opponent_id is not null then
      perform public.record_social_activity(
        new.opponent_id,
        'game_started',
        'challenge:' || new.id::text || ':opponent',
        jsonb_build_object('challengeId', new.id, 'code', new.code, 'gameType', new.game_type, 'clock', new.clock)
      );
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.notify_rating_activity()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare threshold integer;
begin
  if new.rating > old.rating and floor(new.rating / 100.0) > floor(old.rating / 100.0) then
    threshold := floor(new.rating / 100.0)::integer * 100;
    perform public.record_social_activity(
      new.id,
      'rating_reached',
      'rating:' || threshold::text,
      jsonb_build_object('rating', new.rating, 'threshold', threshold)
    );
  end if;
  return new;
end;
$$;

create or replace function public.notify_achievement_activity()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.record_social_activity(
    new.user_id,
    'achievement_earned',
    'achievement:' || new.achievement_key,
    jsonb_build_object('achievementKey', new.achievement_key, 'metadata', coalesce(new.metadata, '{}'::jsonb))
  );
  return new;
end;
$$;

drop trigger if exists game_challenge_activity on public.game_challenges;
create trigger game_challenge_activity
after insert or update on public.game_challenges
for each row execute function public.notify_game_activity();

drop trigger if exists profile_rating_activity on public.profiles;
create trigger profile_rating_activity
after update of rating on public.profiles
for each row execute function public.notify_rating_activity();

drop trigger if exists player_achievement_activity on public.player_achievements;
create trigger player_achievement_activity
after insert on public.player_achievements
for each row execute function public.notify_achievement_activity();

do $$ begin
  alter publication supabase_realtime add table public.social_activity;
exception when duplicate_object or undefined_object then null;
end $$;

revoke all on function public.social_activity_visible(uuid, uuid) from public;
revoke all on function public.record_social_activity(uuid, text, text, jsonb) from public;
revoke all on function public.publish_learning_activity(text, text, jsonb) from public;
revoke all on function public.get_social_activity_feed(integer, timestamptz) from public;
revoke all on function public.update_activity_visibility(text) from public;
grant execute on function public.get_social_activity_feed(integer, timestamptz) to authenticated;
grant execute on function public.publish_learning_activity(text, text, jsonb) to authenticated;
grant execute on function public.update_activity_visibility(text) to authenticated;
