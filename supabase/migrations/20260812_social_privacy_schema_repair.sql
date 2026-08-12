-- Repair and normalize the social privacy schema.
-- Run after 20260812_strengthen_friend_security.sql if a production database
-- has the original 8-column user_privacy_settings row type or a partially
-- applied Activity Feed migration.

create table if not exists public.user_privacy_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile_visibility text not null default 'friends',
  allow_friend_requests text not null default 'on',
  allow_challenges text not null default 'on',
  allow_messages text not null default 'friends',
  online_status text not null default 'show',
  match_history_visibility text not null default 'friends',
  updated_at timestamptz not null default now(),
  allow_spectating text not null default 'friends',
  activity_visibility text not null default 'friends'
);

alter table public.user_privacy_settings
  add column if not exists allow_spectating text;
alter table public.user_privacy_settings
  add column if not exists activity_visibility text;

alter table public.user_privacy_settings
  alter column profile_visibility set default 'friends',
  alter column allow_friend_requests set default 'on',
  alter column allow_challenges set default 'on',
  alter column allow_messages set default 'friends',
  alter column online_status set default 'show',
  alter column match_history_visibility set default 'friends',
  alter column allow_spectating set default 'friends',
  alter column activity_visibility set default 'friends',
  alter column updated_at set default now();

update public.user_privacy_settings
set profile_visibility = case when profile_visibility in ('public', 'friends', 'private') then profile_visibility else 'friends' end,
  allow_friend_requests = case when allow_friend_requests in ('on', 'friends', 'off') then allow_friend_requests else 'on' end,
  allow_challenges = case when allow_challenges in ('on', 'friends', 'off') then allow_challenges else 'on' end,
  allow_messages = case when allow_messages in ('on', 'friends', 'off') then allow_messages else 'friends' end,
  online_status = case when online_status in ('show', 'friends', 'hide') then online_status else 'show' end,
  match_history_visibility = case when match_history_visibility in ('public', 'friends', 'private') then match_history_visibility else 'friends' end,
  allow_spectating = case when allow_spectating in ('on', 'friends', 'off') then allow_spectating else 'friends' end,
  activity_visibility = case when activity_visibility in ('public', 'friends', 'private') then activity_visibility else 'friends' end,
  updated_at = coalesce(updated_at, now());

alter table public.user_privacy_settings
  alter column profile_visibility set not null,
  alter column allow_friend_requests set not null,
  alter column allow_challenges set not null,
  alter column allow_messages set not null,
  alter column online_status set not null,
  alter column match_history_visibility set not null,
  alter column allow_spectating set not null,
  alter column activity_visibility set not null,
  alter column updated_at set not null;

alter table public.user_privacy_settings
  drop constraint if exists user_privacy_settings_profile_visibility_check;
alter table public.user_privacy_settings
  add constraint user_privacy_settings_profile_visibility_check
  check (profile_visibility in ('public', 'friends', 'private'));
alter table public.user_privacy_settings
  drop constraint if exists user_privacy_settings_allow_friend_requests_check;
alter table public.user_privacy_settings
  add constraint user_privacy_settings_allow_friend_requests_check
  check (allow_friend_requests in ('on', 'friends', 'off'));
alter table public.user_privacy_settings
  drop constraint if exists user_privacy_settings_allow_challenges_check;
alter table public.user_privacy_settings
  add constraint user_privacy_settings_allow_challenges_check
  check (allow_challenges in ('on', 'friends', 'off'));
alter table public.user_privacy_settings
  drop constraint if exists user_privacy_settings_allow_messages_check;
alter table public.user_privacy_settings
  add constraint user_privacy_settings_allow_messages_check
  check (allow_messages in ('on', 'friends', 'off'));
alter table public.user_privacy_settings
  drop constraint if exists user_privacy_settings_online_status_check;
alter table public.user_privacy_settings
  add constraint user_privacy_settings_online_status_check
  check (online_status in ('show', 'friends', 'hide'));
alter table public.user_privacy_settings
  drop constraint if exists user_privacy_settings_match_history_visibility_check;
alter table public.user_privacy_settings
  add constraint user_privacy_settings_match_history_visibility_check
  check (match_history_visibility in ('public', 'friends', 'private'));
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

alter table public.user_privacy_settings enable row level security;
revoke all on table public.user_privacy_settings from anon, authenticated;

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

create or replace function public.update_user_privacy_settings_v2(
  p_profile_visibility text,
  p_allow_friend_requests text,
  p_allow_challenges text,
  p_allow_messages text,
  p_allow_spectating text,
  p_online_status text,
  p_match_history_visibility text
)
returns public.user_privacy_settings
language plpgsql security definer set search_path = public
as $$
declare current_user_id uuid := auth.uid(); saved public.user_privacy_settings;
begin
  if current_user_id is null then raise exception 'Sign in to update privacy'; end if;
  if p_profile_visibility not in ('public', 'friends', 'private')
    or p_allow_friend_requests not in ('on', 'friends', 'off')
    or p_allow_challenges not in ('on', 'friends', 'off')
    or p_allow_messages not in ('on', 'friends', 'off')
    or p_allow_spectating not in ('on', 'friends', 'off')
    or p_online_status not in ('show', 'friends', 'hide')
    or p_match_history_visibility not in ('public', 'friends', 'private') then
    raise exception 'Privacy setting is invalid';
  end if;
  insert into public.user_privacy_settings(
    user_id,
    profile_visibility,
    allow_friend_requests,
    allow_challenges,
    allow_messages,
    allow_spectating,
    online_status,
    match_history_visibility,
    updated_at
  )
  values (
    current_user_id,
    p_profile_visibility,
    p_allow_friend_requests,
    p_allow_challenges,
    p_allow_messages,
    p_allow_spectating,
    p_online_status,
    p_match_history_visibility,
    now()
  )
  on conflict (user_id) do update set
    profile_visibility = excluded.profile_visibility,
    allow_friend_requests = excluded.allow_friend_requests,
    allow_challenges = excluded.allow_challenges,
    allow_messages = excluded.allow_messages,
    allow_spectating = excluded.allow_spectating,
    online_status = excluded.online_status,
    match_history_visibility = excluded.match_history_visibility,
    updated_at = now()
  returning * into saved;
  return saved;
end;
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
  on conflict (user_id) do update set
    activity_visibility = excluded.activity_visibility,
    updated_at = now()
  returning * into saved;
  return saved;
end;
$$;

do $$
declare
  missing_columns text[];
begin
  select array_agg(expected.column_name order by expected.column_name)
    into missing_columns
  from unnest(array[
    'user_id',
    'profile_visibility',
    'allow_friend_requests',
    'allow_challenges',
    'allow_messages',
    'online_status',
    'match_history_visibility',
    'updated_at',
    'allow_spectating',
    'activity_visibility'
  ]) as expected(column_name)
  where not exists (
    select 1
    from information_schema.columns actual
    where actual.table_schema = 'public'
      and actual.table_name = 'user_privacy_settings'
      and actual.column_name = expected.column_name
  );

  if missing_columns is not null then
    raise exception 'user_privacy_settings is still missing columns: %', array_to_string(missing_columns, ', ');
  end if;
end $$;

revoke all on function public.get_user_privacy_settings() from public;
revoke all on function public.update_user_privacy_settings_v2(text, text, text, text, text, text, text) from public;
revoke all on function public.update_activity_visibility(text) from public;
grant execute on function public.get_user_privacy_settings() to authenticated;
grant execute on function public.update_user_privacy_settings_v2(text, text, text, text, text, text, text) to authenticated;
grant execute on function public.update_activity_visibility(text) to authenticated;
