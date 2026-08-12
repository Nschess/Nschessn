-- Friend/social security hardening.
-- Apply after supabase/friends.sql and supabase/moderation.sql.
--
-- The move-state RPC remains intentionally unchanged: it already authorizes
-- every write to a current challenge participant and is part of the realtime
-- chess engine.  The triggers below secure the social edges around it (friend
-- requests, challenge creation/acceptance, chat, privacy and notifications)
-- without changing the move protocol.

create table if not exists public.user_privacy_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile_visibility text not null default 'friends'
    check (profile_visibility in ('public', 'friends', 'private')),
  allow_friend_requests text not null default 'on'
    check (allow_friend_requests in ('on', 'friends', 'off')),
  allow_challenges text not null default 'on'
    check (allow_challenges in ('on', 'friends', 'off')),
  allow_messages text not null default 'friends'
    check (allow_messages in ('on', 'friends', 'off')),
  online_status text not null default 'show'
    check (online_status in ('show', 'friends', 'hide')),
  match_history_visibility text not null default 'friends'
    check (match_history_visibility in ('public', 'friends', 'private')),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id, blocker_id);

create table if not exists public.social_rate_limits (
  actor_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (length(action) between 1 and 64),
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  primary key (actor_id, action)
);

create table if not exists public.social_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  type text not null check (type in (
    'friend_request', 'friend_accepted', 'friend_declined',
    'challenge_received', 'challenge_accepted', 'challenge_declined',
    'message_received', 'gift_received'
  )),
  entity_id uuid,
  entity_code text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  expires_at timestamptz not null default now() + interval '30 days'
);

create index if not exists social_notifications_recipient_idx
  on public.social_notifications (recipient_id, read_at, created_at desc);

alter table public.user_privacy_settings enable row level security;
alter table public.user_blocks enable row level security;
alter table public.social_rate_limits enable row level security;
alter table public.social_notifications enable row level security;

-- Realtime presence/request events are readable only through an accepted
-- relationship (or the participant's own request/presence row).
drop policy if exists friend_presence_social_read on public.friend_presence;
create policy friend_presence_social_read on public.friend_presence
  for select to authenticated using (
    auth.uid() = user_id or exists (
      select 1 from public.friend_requests request
      where request.status = 'accepted'
        and ((request.sender_id = auth.uid() and request.receiver_id = friend_presence.user_id)
          or (request.receiver_id = auth.uid() and request.sender_id = friend_presence.user_id))
    )
  );

drop policy if exists social_notifications_owner_read on public.social_notifications;
create policy social_notifications_owner_read on public.social_notifications
  for select to authenticated using (auth.uid() = recipient_id);
drop policy if exists social_notifications_owner_update on public.social_notifications;
create policy social_notifications_owner_update on public.social_notifications
  for update to authenticated using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);

-- Realtime needs SELECT for the recipient filter; RLS still limits rows to the
-- signed-in recipient.  All writes remain RPC/trigger-owned.
grant select on public.social_notifications to authenticated;
revoke all on table public.user_privacy_settings, public.user_blocks, public.social_rate_limits from anon, authenticated;
revoke insert, update, delete on table public.social_notifications from anon, authenticated;

create or replace function public.is_social_blocked(p_first uuid, p_second uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select p_first is not null and p_second is not null and exists (
    select 1 from public.user_blocks as block
    where (block.blocker_id = p_first and block.blocked_id = p_second)
       or (block.blocker_id = p_second and block.blocked_id = p_first)
  );
$$;

create or replace function public.is_social_friend(p_first uuid, p_second uuid)
returns boolean
language sql
security definer set search_path = public
stable
as $$
  select p_first is not null and p_second is not null and exists (
    select 1 from public.friend_requests as request
    where request.status = 'accepted'
      and ((request.sender_id = p_first and request.receiver_id = p_second)
        or (request.sender_id = p_second and request.receiver_id = p_first))
  );
$$;

create or replace function public.social_action_allowed(p_actor uuid, p_target uuid, p_action text)
returns boolean
language plpgsql
security definer set search_path = public
stable
as $$
declare
  setting text;
  friends boolean;
begin
  if p_actor is null or p_target is null or p_actor = p_target then return false; end if;
  if public.is_social_blocked(p_actor, p_target) then return false; end if;
  friends := public.is_social_friend(p_actor, p_target);
  if p_action = 'friend_request' then
    select coalesce(allow_friend_requests, 'on') into setting from public.user_privacy_settings where user_id = p_target;
  elsif p_action = 'challenge' then
    select coalesce(allow_challenges, 'on') into setting from public.user_privacy_settings where user_id = p_target;
  elsif p_action = 'message' then
    select coalesce(allow_messages, 'friends') into setting from public.user_privacy_settings where user_id = p_target;
  else
    return false;
  end if;
  setting := coalesce(setting, case when p_action = 'message' then 'friends' else 'on' end);
  return setting = 'on' or (setting = 'friends' and friends);
end;
$$;

create or replace function public.assert_social_action(p_actor uuid, p_target uuid, p_action text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  -- Deliberately use one message for blocked and private accounts so callers
  -- cannot probe another player's block/privacy state.
  if not public.social_action_allowed(p_actor, p_target, p_action) then
    raise exception 'This player is not accepting this interaction';
  end if;
end;
$$;

create or replace function public.consume_social_rate_limit(
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  actor uuid := auth.uid();
  current_limit public.social_rate_limits;
  now_at timestamptz := now();
begin
  if actor is null then raise exception 'Sign in to continue'; end if;
  if p_limit < 1 or p_window_seconds < 1 then raise exception 'Rate limit configuration is invalid'; end if;
  select * into current_limit from public.social_rate_limits
  where actor_id = actor and action = left(trim(p_action), 64)
  for update;
  if not found or current_limit.window_started_at <= now_at - make_interval(secs => p_window_seconds) then
    insert into public.social_rate_limits(actor_id, action, window_started_at, attempt_count)
    values (actor, left(trim(p_action), 64), now_at, 1)
    on conflict (actor_id, action) do update set window_started_at = excluded.window_started_at, attempt_count = 1;
  elsif current_limit.attempt_count >= p_limit then
    raise exception 'Too many requests. Please try again later.' using errcode = 'P0001';
  else
    update public.social_rate_limits set attempt_count = attempt_count + 1 where actor_id = actor and action = current_limit.action;
  end if;
end;
$$;

create or replace function public.create_social_notification(
  p_recipient uuid,
  p_actor uuid,
  p_type text,
  p_entity_id uuid default null,
  p_entity_code text default null,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  notification_id uuid;
begin
  if p_recipient is null or p_recipient = p_actor then return null; end if;
  insert into public.social_notifications(recipient_id, actor_id, type, entity_id, entity_code, payload)
  values (p_recipient, p_actor, p_type, p_entity_id, nullif(trim(p_entity_code), ''), coalesce(p_payload, '{}'::jsonb))
  returning id into notification_id;
  return notification_id;
end;
$$;

-- Reports are also an abuse vector.  Keep the existing report RPC/API, but
-- enforce identity, a daily cap, and context ownership in the database.
create or replace function public.security_check_user_report()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null or auth.uid() <> new.reporter_id then raise exception 'You cannot submit this report'; end if;
  perform public.consume_social_rate_limit('report', 20, 86400);
  if new.subject_user_id is null or new.subject_user_id = new.reporter_id then raise exception 'Choose another player to report'; end if;
  if not exists (select 1 from public.profiles where id = new.subject_user_id) then raise exception 'That player is unavailable'; end if;
  if new.context_type = 'friend_game' and not exists (
    select 1 from public.game_challenges challenge
    where challenge.code = nullif(trim(new.context_id), '')
      and new.reporter_id in (challenge.creator_id, challenge.opponent_id)
  ) then raise exception 'That game context is unavailable'; end if;
  return new;
end;
$$;

do $$ begin
  if to_regclass('public.user_reports') is not null then
    execute 'drop trigger if exists user_report_security on public.user_reports';
    execute 'create trigger user_report_security before insert on public.user_reports for each row execute function public.security_check_user_report()';
  end if;
end $$;

create or replace function public.security_check_friend_request()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is null or auth.uid() <> new.sender_id then raise exception 'You cannot create this request'; end if;
    perform public.consume_social_rate_limit('friend_request', 20, 3600);
    perform public.assert_social_action(new.sender_id, new.receiver_id, 'friend_request');
  elsif tg_op = 'UPDATE' and new.status = 'accepted' and old.status is distinct from 'accepted' then
    if auth.uid() is null or auth.uid() <> new.receiver_id then raise exception 'You cannot accept this request'; end if;
    perform public.consume_social_rate_limit('friend_request', 20, 3600);
    perform public.assert_social_action(new.receiver_id, new.sender_id, 'friend_request');
  end if;
  return new;
end;
$$;

create or replace function public.notify_friend_request_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform public.create_social_notification(new.receiver_id, new.sender_id, 'friend_request', new.id, null, '{}'::jsonb);
  elsif tg_op = 'UPDATE' and old.status is distinct from 'pending' and new.status = 'pending' then
    perform public.create_social_notification(new.receiver_id, new.sender_id, 'friend_request', new.id, null, '{}'::jsonb);
  elsif tg_op = 'UPDATE' and old.status is distinct from 'accepted' and new.status = 'accepted' then
    perform public.create_social_notification(new.sender_id, new.receiver_id, 'friend_accepted', new.id, null, '{}'::jsonb);
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'declined' then
    perform public.create_social_notification(new.sender_id, new.receiver_id, 'friend_declined', new.id, null, '{}'::jsonb);
  end if;
  return new;
end;
$$;

drop trigger if exists friend_request_security on public.friend_requests;
create trigger friend_request_security
before insert or update on public.friend_requests
for each row execute function public.security_check_friend_request();
drop trigger if exists friend_request_notification on public.friend_requests;
create trigger friend_request_notification
after insert or update on public.friend_requests
for each row execute function public.notify_friend_request_change();

create or replace function public.security_check_game_challenge()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is null or auth.uid() <> new.creator_id then raise exception 'You cannot create this challenge'; end if;
    perform public.consume_social_rate_limit('challenge_create', 30, 3600);
    if new.opponent_id is not null then perform public.assert_social_action(new.creator_id, new.opponent_id, 'challenge'); end if;
  elsif tg_op = 'UPDATE' and old.opponent_id is distinct from new.opponent_id and new.opponent_id is not null then
    if auth.uid() is null or auth.uid() <> new.opponent_id then raise exception 'You cannot accept this challenge'; end if;
    perform public.consume_social_rate_limit('challenge_accept', 30, 3600);
    perform public.assert_social_action(new.opponent_id, new.creator_id, 'challenge');
  end if;
  return new;
end;
$$;

create or replace function public.notify_game_challenge_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.opponent_id is not null then
    perform public.create_social_notification(new.opponent_id, new.creator_id, 'challenge_received', new.id, new.code, '{}'::jsonb);
  elsif tg_op = 'UPDATE' and old.opponent_id is distinct from new.opponent_id and new.opponent_id is not null then
    perform public.create_social_notification(new.creator_id, new.opponent_id, 'challenge_accepted', new.id, new.code, '{}'::jsonb);
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'declined' then
    perform public.create_social_notification(new.creator_id, new.opponent_id, 'challenge_declined', new.id, new.code, '{}'::jsonb);
  end if;
  return new;
end;
$$;

drop trigger if exists game_challenge_security on public.game_challenges;
create trigger game_challenge_security
before insert or update on public.game_challenges
for each row execute function public.security_check_game_challenge();
drop trigger if exists game_challenge_notification on public.game_challenges;
create trigger game_challenge_notification
after insert or update on public.game_challenges
for each row execute function public.notify_game_challenge_change();

create or replace function public.security_check_challenge_message()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  challenge public.game_challenges;
  other_user uuid;
begin
  if auth.uid() is null or auth.uid() <> new.user_id then raise exception 'You cannot send this message'; end if;
  select * into challenge from public.game_challenges where id = new.challenge_id;
  if challenge.id is null or new.user_id not in (challenge.creator_id, challenge.opponent_id) then raise exception 'This game is unavailable'; end if;
  other_user := case when new.user_id = challenge.creator_id then challenge.opponent_id else challenge.creator_id end;
  if other_user is null then raise exception 'Chat is not ready'; end if;
  perform public.consume_social_rate_limit('challenge_message', 120, 600);
  perform public.assert_social_action(new.user_id, other_user, 'message');
  return new;
end;
$$;

create or replace function public.notify_challenge_message()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  challenge public.game_challenges;
  recipient uuid;
begin
  select * into challenge from public.game_challenges where id = new.challenge_id;
  recipient := case when new.user_id = challenge.creator_id then challenge.opponent_id else challenge.creator_id end;
  perform public.create_social_notification(recipient, new.user_id, 'message_received', new.challenge_id, challenge.code, jsonb_build_object('messageId', new.id));
  return new;
end;
$$;

drop trigger if exists challenge_message_security on public.game_challenge_messages;
create trigger challenge_message_security
before insert on public.game_challenge_messages
for each row execute function public.security_check_challenge_message();
drop trigger if exists challenge_message_notification on public.game_challenge_messages;
create trigger challenge_message_notification
after insert on public.game_challenge_messages
for each row execute function public.notify_challenge_message();

drop function if exists public.get_user_privacy_settings();
create function public.get_user_privacy_settings()
returns public.user_privacy_settings
language sql
security definer set search_path = public
stable
as $$
  select coalesce(
    (select settings from public.user_privacy_settings as settings where settings.user_id = auth.uid()),
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

create or replace function public.update_user_privacy_settings(
  p_profile_visibility text,
  p_allow_friend_requests text,
  p_allow_challenges text,
  p_allow_messages text,
  p_online_status text,
  p_match_history_visibility text
)
returns public.user_privacy_settings
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  saved public.user_privacy_settings;
begin
  if current_user_id is null then raise exception 'Sign in to update privacy'; end if;
  if p_profile_visibility not in ('public', 'friends', 'private')
    or p_allow_friend_requests not in ('on', 'friends', 'off')
    or p_allow_challenges not in ('on', 'friends', 'off')
    or p_allow_messages not in ('on', 'friends', 'off')
    or p_online_status not in ('show', 'friends', 'hide')
    or p_match_history_visibility not in ('public', 'friends', 'private') then
    raise exception 'Privacy setting is invalid';
  end if;
  insert into public.user_privacy_settings(user_id, profile_visibility, allow_friend_requests, allow_challenges, allow_messages, online_status, match_history_visibility, updated_at)
  values (current_user_id, p_profile_visibility, p_allow_friend_requests, p_allow_challenges, p_allow_messages, p_online_status, p_match_history_visibility, now())
  on conflict (user_id) do update set
    profile_visibility = excluded.profile_visibility,
    allow_friend_requests = excluded.allow_friend_requests,
    allow_challenges = excluded.allow_challenges,
    allow_messages = excluded.allow_messages,
    online_status = excluded.online_status,
    match_history_visibility = excluded.match_history_visibility,
    updated_at = now()
  returning * into saved;
  return saved;
end;
$$;

create or replace function public.block_user(p_target_user uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null or p_target_user is null or p_target_user = auth.uid() then raise exception 'Choose another registered player'; end if;
  if not exists (select 1 from public.profiles where id = p_target_user) then raise exception 'That player is unavailable'; end if;
  perform public.consume_social_rate_limit('block', 30, 86400);
  insert into public.user_blocks(blocker_id, blocked_id) values (auth.uid(), p_target_user) on conflict do nothing;
  delete from public.friend_requests
  where (sender_id = auth.uid() and receiver_id = p_target_user)
     or (sender_id = p_target_user and receiver_id = auth.uid());
end;
$$;

create or replace function public.unblock_user(p_target_user uuid)
returns void
language sql
security definer set search_path = public
as $$
  delete from public.user_blocks where blocker_id = auth.uid() and blocked_id = p_target_user;
$$;

create or replace function public.list_user_blocks()
returns table(blocked_id uuid, username text, created_at timestamptz)
language sql
security definer set search_path = public
stable
as $$
  select block.blocked_id, profile.username, block.created_at
  from public.user_blocks as block
  left join public.profiles as profile on profile.id = block.blocked_id
  where block.blocker_id = auth.uid()
  order by block.created_at desc;
$$;

drop function if exists public.search_registered_players(text);
create function public.search_registered_players(p_query text)
returns table (
  public_id uuid,
  username text,
  avatar text,
  country_flag text,
  rating integer,
  title text,
  last_login_at timestamptz
)
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Sign in to search players'; end if;
  perform public.consume_social_rate_limit('player_search', 60, 60);
  return query
  select profile.id, profile.username, profile.avatar, coalesce(to_jsonb(profile) ->> 'country_flag', ''), profile.rating, profile.title, profile.last_login_at
  from public.profiles as profile
  where auth.uid() is not null
    and profile.id <> auth.uid()
    and not coalesce(profile.is_bot, false)
    and profile.username ilike '%' || left(trim(coalesce(p_query, '')), 20) || '%'
    and coalesce((select settings.profile_visibility from public.user_privacy_settings settings where settings.user_id = profile.id), 'friends') <> 'private'
    and not public.is_social_blocked(auth.uid(), profile.id)
  order by profile.last_login_at desc nulls last, profile.username
  limit 8;
end;
$$;

drop function if exists public.get_friend_directory();
create function public.get_friend_directory()
returns table (
  request_id uuid,
  public_id uuid,
  username text,
  avatar text,
  rating integer,
  title text,
  last_login_at timestamptz,
  request_status text,
  request_direction text,
  online boolean
)
language sql
security definer set search_path = public
stable
as $$
  select request.id, profile.id, profile.username, profile.avatar, profile.rating, profile.title, profile.last_login_at,
    request.status,
    case when request.sender_id = auth.uid() then 'outgoing' else 'incoming' end,
    case when request.status = 'accepted'
      and coalesce((select settings.online_status from public.user_privacy_settings settings where settings.user_id = profile.id), 'show') <> 'hide'
      then coalesce(presence.connected and presence.last_seen > now() - interval '75 seconds', false)
      else false end
  from public.friend_requests request
  join public.profiles profile on profile.id = case when request.sender_id = auth.uid() then request.receiver_id else request.sender_id end
  left join public.friend_presence presence on presence.user_id = profile.id
  where auth.uid() is not null
    and (request.sender_id = auth.uid() or request.receiver_id = auth.uid())
    and request.status in ('pending', 'accepted')
    and not public.is_social_blocked(auth.uid(), profile.id)
  order by request.updated_at desc;
$$;

drop function if exists public.get_game_challenge(text);
create function public.get_game_challenge(p_code text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  found public.game_challenges;
begin
  if current_user_id is null then raise exception 'Sign in to open a challenge'; end if;
  perform public.consume_social_rate_limit('challenge_open', 120, 3600);
  perform public.expire_game_challenges();
  select * into found from public.game_challenges where code = upper(trim(p_code));
  if found.id is null then raise exception 'Challenge not found or expired'; end if;
  if found.creator_id <> current_user_id and found.opponent_id is distinct from current_user_id then
    if found.opponent_id is not null or found.status <> 'pending' then raise exception 'This challenge belongs to another player'; end if;
    perform public.assert_social_action(current_user_id, found.creator_id, 'challenge');
  end if;
  return public.challenge_payload(found);
end;
$$;

create or replace function public.get_social_notifications(p_limit integer default 40)
returns table(id uuid, type text, actor_id uuid, actor_username text, entity_id uuid, entity_code text, payload jsonb, created_at timestamptz, read_at timestamptz)
language sql
security definer set search_path = public
stable
as $$
  select note.id, note.type, note.actor_id, coalesce(profile.username, 'Chess player'), note.entity_id, note.entity_code, note.payload, note.created_at, note.read_at
  from public.social_notifications note
  left join public.profiles profile on profile.id = note.actor_id
  where note.recipient_id = auth.uid() and note.expires_at > now()
  order by note.created_at desc
  limit greatest(1, least(coalesce(p_limit, 40), 100));
$$;

create or replace function public.mark_social_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare changed integer;
begin
  update public.social_notifications
  set read_at = coalesce(read_at, now())
  where recipient_id = auth.uid()
    and read_at is null
    and (p_ids is null or id = any(p_ids));
  get diagnostics changed = row_count;
  return changed;
end;
$$;

do $$ begin
  alter publication supabase_realtime add table public.social_notifications;
exception when duplicate_object or undefined_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.friend_requests;
exception when duplicate_object or undefined_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.friend_presence;
exception when duplicate_object or undefined_object then null;
end $$;

revoke all on function public.is_social_blocked(uuid, uuid) from public;
revoke all on function public.is_social_friend(uuid, uuid) from public;
revoke all on function public.social_action_allowed(uuid, uuid, text) from public;
revoke all on function public.assert_social_action(uuid, uuid, text) from public;
revoke all on function public.consume_social_rate_limit(text, integer, integer) from public;
revoke all on function public.create_social_notification(uuid, uuid, text, uuid, text, jsonb) from public;
revoke all on function public.security_check_user_report() from public;
revoke all on function public.security_check_friend_request() from public;
revoke all on function public.notify_friend_request_change() from public;
revoke all on function public.security_check_game_challenge() from public;
revoke all on function public.notify_game_challenge_change() from public;
revoke all on function public.security_check_challenge_message() from public;
revoke all on function public.notify_challenge_message() from public;
revoke all on function public.get_user_privacy_settings() from public;
revoke all on function public.update_user_privacy_settings(text, text, text, text, text, text) from public;
revoke all on function public.block_user(uuid) from public;
revoke all on function public.unblock_user(uuid) from public;
revoke all on function public.list_user_blocks() from public;
revoke all on function public.search_registered_players(text) from public;
revoke all on function public.get_friend_directory() from public;
revoke all on function public.get_game_challenge(text) from public;
revoke all on function public.get_social_notifications(integer) from public;
revoke all on function public.mark_social_notifications_read(uuid[]) from public;

grant execute on function public.get_user_privacy_settings() to authenticated;
grant execute on function public.update_user_privacy_settings(text, text, text, text, text, text) to authenticated;
grant execute on function public.block_user(uuid) to authenticated;
grant execute on function public.unblock_user(uuid) to authenticated;
grant execute on function public.list_user_blocks() to authenticated;
grant execute on function public.search_registered_players(text) to authenticated;
grant execute on function public.get_friend_directory() to authenticated;
grant execute on function public.get_game_challenge(text) to authenticated;
grant execute on function public.get_social_notifications(integer) to authenticated;
grant execute on function public.mark_social_notifications_read(uuid[]) to authenticated;
