-- Persistent direct messaging and complete social privacy controls.
-- Apply after 20260812_strengthen_friend_security.sql.

alter table public.user_privacy_settings
  add column if not exists allow_spectating text;
alter table public.user_privacy_settings
  alter column allow_spectating set default 'friends';
update public.user_privacy_settings
set allow_spectating = 'friends'
where allow_spectating is null
  or allow_spectating not in ('on', 'friends', 'off');
alter table public.user_privacy_settings
  alter column allow_spectating set not null;
alter table public.user_privacy_settings
  drop constraint if exists user_privacy_settings_allow_spectating_check;
alter table public.user_privacy_settings
  add constraint user_privacy_settings_allow_spectating_check
  check (allow_spectating in ('on', 'friends', 'off'));

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table if not exists public.conversation_participants (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  muted boolean not null default false,
  last_read_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (length(trim(body)) between 1 and 1000),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

create table if not exists public.conversation_typing (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  is_typing boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists conversation_participants_user_idx on public.conversation_participants(user_id, joined_at desc);
create index if not exists direct_messages_conversation_idx on public.direct_messages(conversation_id, created_at desc);
create index if not exists conversation_typing_active_idx on public.conversation_typing(conversation_id, updated_at desc);

alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.direct_messages enable row level security;
alter table public.conversation_typing enable row level security;

drop policy if exists conversations_member_read on public.conversations;
create policy conversations_member_read on public.conversations for select to authenticated
  using (exists (select 1 from public.conversation_participants p where p.conversation_id = conversations.id and p.user_id = auth.uid())
    and exists (select 1 from public.conversation_participants other where other.conversation_id = conversations.id and other.user_id <> auth.uid()
      and public.social_action_allowed(auth.uid(), other.user_id, 'message')));
drop policy if exists conversation_participants_member_read on public.conversation_participants;
create policy conversation_participants_member_read on public.conversation_participants for select to authenticated
  using ((user_id = auth.uid() or exists (select 1 from public.conversation_participants own where own.conversation_id = conversation_participants.conversation_id and own.user_id = auth.uid()))
    and exists (select 1 from public.conversation_participants other where other.conversation_id = conversation_participants.conversation_id and other.user_id <> auth.uid()
      and public.social_action_allowed(auth.uid(), other.user_id, 'message')));
drop policy if exists direct_messages_member_read on public.direct_messages;
create policy direct_messages_member_read on public.direct_messages for select to authenticated
  using (exists (select 1 from public.conversation_participants p where p.conversation_id = direct_messages.conversation_id and p.user_id = auth.uid())
    and exists (select 1 from public.conversation_participants other where other.conversation_id = direct_messages.conversation_id and other.user_id <> auth.uid()
      and public.social_action_allowed(auth.uid(), other.user_id, 'message')));
drop policy if exists conversation_typing_member_read on public.conversation_typing;
create policy conversation_typing_member_read on public.conversation_typing for select to authenticated
  using (exists (select 1 from public.conversation_participants p where p.conversation_id = conversation_typing.conversation_id and p.user_id = auth.uid())
    and exists (select 1 from public.conversation_participants other where other.conversation_id = conversation_typing.conversation_id and other.user_id <> auth.uid()
      and public.social_action_allowed(auth.uid(), other.user_id, 'message')));

create or replace function public.social_online_status_allowed(p_viewer uuid, p_target uuid)
returns boolean
language plpgsql security definer set search_path = public stable
as $$
declare setting text; friends boolean;
begin
  if p_viewer is null or p_target is null or p_viewer = p_target then return false; end if;
  if public.is_social_blocked(p_viewer, p_target) then return false; end if;
  friends := public.is_social_friend(p_viewer, p_target);
  select coalesce(online_status, 'show') into setting from public.user_privacy_settings where user_id = p_target;
  return coalesce(setting, 'show') = 'show' or (coalesce(setting, 'show') = 'friends' and friends);
end;
$$;

-- Presence is a social signal too. Keep the realtime row policy aligned with
-- the user's online-status setting so hidden presence cannot leak through subscriptions.
drop policy if exists friend_presence_social_read on public.friend_presence;
create policy friend_presence_social_read on public.friend_presence
  for select to authenticated using (
    auth.uid() = user_id or exists (
      select 1 from public.friend_requests request
      where request.status = 'accepted'
        and ((request.sender_id = auth.uid() and request.receiver_id = friend_presence.user_id)
          or (request.receiver_id = auth.uid() and request.sender_id = friend_presence.user_id))
        and public.social_online_status_allowed(auth.uid(), friend_presence.user_id)
    )
  );

revoke all on table public.conversations, public.conversation_participants, public.direct_messages, public.conversation_typing from anon, authenticated;
grant select on public.conversations, public.conversation_participants, public.direct_messages, public.conversation_typing to authenticated;

create or replace function public.social_spectating_allowed(p_viewer uuid, p_target uuid)
returns boolean
language plpgsql security definer set search_path = public stable
as $$
declare setting text; friends boolean;
begin
  if p_viewer is null or p_target is null or p_viewer = p_target then return false; end if;
  if public.is_social_blocked(p_viewer, p_target) then return false; end if;
  friends := public.is_social_friend(p_viewer, p_target);
  select coalesce(allow_spectating, 'friends') into setting from public.user_privacy_settings where user_id = p_target;
  return coalesce(setting, 'friends') = 'on' or (coalesce(setting, 'friends') = 'friends' and friends);
end;
$$;

create or replace function public.assert_social_spectating(p_viewer uuid, p_target uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.social_spectating_allowed(p_viewer, p_target) then raise exception 'This player is not accepting spectators'; end if;
end;
$$;

create or replace function public.social_match_history_allowed(p_viewer uuid, p_target uuid)
returns boolean
language plpgsql security definer set search_path = public stable
as $$
declare setting text; friends boolean;
begin
  if p_viewer is null or p_target is null then return false; end if;
  if p_viewer = p_target then return true; end if;
  if public.is_social_blocked(p_viewer, p_target) then return false; end if;
  friends := public.is_social_friend(p_viewer, p_target);
  select coalesce(match_history_visibility, 'friends') into setting from public.user_privacy_settings where user_id = p_target;
  return coalesce(setting, 'friends') = 'public' or (coalesce(setting, 'friends') = 'friends' and friends);
end;
$$;

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
  insert into public.user_privacy_settings(user_id, profile_visibility, allow_friend_requests, allow_challenges, allow_messages, allow_spectating, online_status, match_history_visibility, updated_at)
  values (current_user_id, p_profile_visibility, p_allow_friend_requests, p_allow_challenges, p_allow_messages, p_allow_spectating, p_online_status, p_match_history_visibility, now())
  on conflict (user_id) do update set profile_visibility = excluded.profile_visibility, allow_friend_requests = excluded.allow_friend_requests,
    allow_challenges = excluded.allow_challenges, allow_messages = excluded.allow_messages, allow_spectating = excluded.allow_spectating,
    online_status = excluded.online_status, match_history_visibility = excluded.match_history_visibility, updated_at = now()
  returning * into saved;
  return saved;
end;
$$;

create or replace function public.get_or_create_conversation(p_target_user uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare me uuid := auth.uid(); conversation_id uuid; existing uuid;
begin
  if me is null then raise exception 'Sign in to message players'; end if;
  if p_target_user is null or p_target_user = me then raise exception 'Choose another player'; end if;
  if not exists (select 1 from public.profiles where id = p_target_user) then raise exception 'That player is unavailable'; end if;
  perform public.assert_social_action(me, p_target_user, 'message');
  perform pg_advisory_xact_lock(hashtextextended(least(me::text, p_target_user::text) || ':' || greatest(me::text, p_target_user::text), 0));
  select p.conversation_id into existing
  from public.conversation_participants p
  join public.conversation_participants other on other.conversation_id = p.conversation_id and other.user_id = p_target_user
  where p.user_id = me
  limit 1;
  if existing is not null then return existing; end if;
  insert into public.conversations default values returning id into conversation_id;
  insert into public.conversation_participants(conversation_id, user_id) values (conversation_id, me), (conversation_id, p_target_user);
  return conversation_id;
end;
$$;

create or replace function public.list_conversations(p_limit integer default 40)
returns table(conversation_id uuid, participant_id uuid, participant_username text, participant_avatar text, participant_online boolean, muted boolean, unread_count bigint, last_body text, last_sender_id uuid, last_message_at timestamptz)
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'Sign in to view messages'; end if;
  return query
  select own.conversation_id, other.user_id, coalesce(profile.username, 'Chess player'), coalesce(profile.avatar, 'auto'),
    case
      when coalesce((select settings.online_status from public.user_privacy_settings settings where settings.user_id = other.user_id), 'show') = 'show' then coalesce(presence.connected and presence.last_seen > now() - interval '75 seconds', false)
      when coalesce((select settings.online_status from public.user_privacy_settings settings where settings.user_id = other.user_id), 'show') = 'friends'
        and public.is_social_friend(auth.uid(), other.user_id) then coalesce(presence.connected and presence.last_seen > now() - interval '75 seconds', false)
      else false
    end,
    own.muted,
    (select count(*) from public.direct_messages unread where unread.conversation_id = own.conversation_id and unread.sender_id <> auth.uid() and unread.created_at > own.last_read_at and unread.deleted_at is null),
    latest.body, latest.sender_id, conversation.last_message_at
  from public.conversation_participants own
  join public.conversation_participants other on other.conversation_id = own.conversation_id and other.user_id <> auth.uid()
  join public.conversations conversation on conversation.id = own.conversation_id
  left join public.profiles profile on profile.id = other.user_id
  left join public.friend_presence presence on presence.user_id = other.user_id
  left join lateral (select message.body, message.sender_id from public.direct_messages message where message.conversation_id = own.conversation_id and message.deleted_at is null order by message.created_at desc limit 1) latest on true
  where own.user_id = auth.uid() and public.social_action_allowed(auth.uid(), other.user_id, 'message')
  order by conversation.last_message_at desc
  limit greatest(1, least(coalesce(p_limit, 40), 100));
end;
$$;

create or replace function public.get_conversation_messages(p_conversation_id uuid, p_before timestamptz default null, p_limit integer default 50)
returns table(id uuid, sender_id uuid, sender_username text, body text, created_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare other_user uuid;
begin
  if auth.uid() is null or not exists (select 1 from public.conversation_participants where conversation_id = p_conversation_id and user_id = auth.uid()) then raise exception 'Conversation is unavailable'; end if;
  select user_id into other_user from public.conversation_participants where conversation_id = p_conversation_id and user_id <> auth.uid() limit 1;
  if other_user is null then raise exception 'Conversation is unavailable'; end if;
  perform public.assert_social_action(auth.uid(), other_user, 'message');
  return query
  select message.id, message.sender_id, coalesce(profile.username, 'Chess player'), message.body, message.created_at
  from public.direct_messages message left join public.profiles profile on profile.id = message.sender_id
  where message.conversation_id = p_conversation_id and message.deleted_at is null and (p_before is null or message.created_at < p_before)
  order by message.created_at desc limit greatest(1, least(coalesce(p_limit, 50), 100));
end;
$$;

create or replace function public.send_direct_message(p_conversation_id uuid, p_body text)
returns public.direct_messages
language plpgsql security definer set search_path = public
as $$
declare me uuid := auth.uid(); other_user uuid; clean_body text := left(trim(coalesce(p_body, '')), 1000); saved public.direct_messages;
begin
  if me is null then raise exception 'Sign in to send messages'; end if;
  if length(clean_body) = 0 then raise exception 'Write a message first'; end if;
  if not exists (select 1 from public.conversation_participants where conversation_id = p_conversation_id and user_id = me) then raise exception 'Conversation is unavailable'; end if;
  select user_id into other_user from public.conversation_participants where conversation_id = p_conversation_id and user_id <> me limit 1;
  perform public.assert_social_action(me, other_user, 'message');
  perform public.consume_social_rate_limit('direct_message', 120, 600);
  insert into public.direct_messages(conversation_id, sender_id, body) values (p_conversation_id, me, clean_body) returning * into saved;
  update public.conversations set updated_at = now(), last_message_at = saved.created_at where id = p_conversation_id;
  if not exists (select 1 from public.conversation_participants where conversation_id = p_conversation_id and user_id = other_user and muted) then
    perform public.create_social_notification(other_user, me, 'message_received', p_conversation_id, null, jsonb_build_object('messageId', saved.id));
  end if;
  return saved;
end;
$$;

create or replace function public.set_conversation_read(p_conversation_id uuid)
returns void language plpgsql security definer set search_path = public
as $$ declare other_user uuid; begin
  select user_id into other_user from public.conversation_participants where conversation_id = p_conversation_id and user_id <> auth.uid() limit 1;
  perform public.assert_social_action(auth.uid(), other_user, 'message');
  update public.conversation_participants set last_read_at = now() where conversation_id = p_conversation_id and user_id = auth.uid();
  if not found then raise exception 'Conversation is unavailable'; end if;
end; $$;

create or replace function public.set_conversation_muted(p_conversation_id uuid, p_muted boolean)
returns void language plpgsql security definer set search_path = public
as $$ declare other_user uuid; begin
  select user_id into other_user from public.conversation_participants where conversation_id = p_conversation_id and user_id <> auth.uid() limit 1;
  perform public.assert_social_action(auth.uid(), other_user, 'message');
  update public.conversation_participants set muted = coalesce(p_muted, false) where conversation_id = p_conversation_id and user_id = auth.uid();
  if not found then raise exception 'Conversation is unavailable'; end if;
end; $$;

create or replace function public.set_conversation_typing(p_conversation_id uuid, p_is_typing boolean)
returns void language plpgsql security definer set search_path = public
as $$ declare other_user uuid; begin
  select user_id into other_user from public.conversation_participants where conversation_id = p_conversation_id and user_id <> auth.uid() limit 1;
  perform public.assert_social_action(auth.uid(), other_user, 'message');
  perform public.consume_social_rate_limit('typing', 300, 60);
  if not exists (select 1 from public.conversation_participants where conversation_id = p_conversation_id and user_id = auth.uid()) then raise exception 'Conversation is unavailable'; end if;
  insert into public.conversation_typing(conversation_id, user_id, is_typing, updated_at) values (p_conversation_id, auth.uid(), coalesce(p_is_typing, false), now())
  on conflict (conversation_id, user_id) do update set is_typing = excluded.is_typing, updated_at = excluded.updated_at;
end; $$;

create or replace function public.get_conversation_typing(p_conversation_id uuid)
returns table(user_id uuid, is_typing boolean, updated_at timestamptz)
language plpgsql security definer set search_path = public stable
as $$
declare other_user uuid;
begin
  if not exists (select 1 from public.conversation_participants where conversation_id = p_conversation_id and user_id = auth.uid()) then raise exception 'Conversation is unavailable'; end if;
  select user_id into other_user from public.conversation_participants where conversation_id = p_conversation_id and user_id <> auth.uid() limit 1;
  perform public.assert_social_action(auth.uid(), other_user, 'message');
  return query select typing.user_id, typing.is_typing, typing.updated_at from public.conversation_typing typing
    where typing.conversation_id = p_conversation_id and typing.user_id <> auth.uid() and typing.updated_at > now() - interval '12 seconds';
end;
$$;

do $$ begin alter publication supabase_realtime add table public.conversations; exception when duplicate_object or undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.conversation_participants; exception when duplicate_object or undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.direct_messages; exception when duplicate_object or undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.conversation_typing; exception when duplicate_object or undefined_object then null; end $$;

revoke all on function public.social_spectating_allowed(uuid, uuid) from public;
revoke all on function public.assert_social_spectating(uuid, uuid) from public;
revoke all on function public.social_match_history_allowed(uuid, uuid) from public;
revoke all on function public.social_online_status_allowed(uuid, uuid) from public;
revoke all on function public.get_user_privacy_settings() from public;
revoke all on function public.update_user_privacy_settings_v2(text, text, text, text, text, text, text) from public;
revoke all on function public.get_or_create_conversation(uuid) from public;
revoke all on function public.list_conversations(integer) from public;
revoke all on function public.get_conversation_messages(uuid, timestamptz, integer) from public;
revoke all on function public.send_direct_message(uuid, text) from public;
revoke all on function public.set_conversation_read(uuid) from public;
revoke all on function public.set_conversation_muted(uuid, boolean) from public;
revoke all on function public.set_conversation_typing(uuid, boolean) from public;
revoke all on function public.get_conversation_typing(uuid) from public;
grant execute on function public.social_spectating_allowed(uuid, uuid) to authenticated;
grant execute on function public.assert_social_spectating(uuid, uuid) to authenticated;
grant execute on function public.social_match_history_allowed(uuid, uuid) to authenticated;
grant execute on function public.social_online_status_allowed(uuid, uuid) to authenticated;
grant execute on function public.get_user_privacy_settings() to authenticated;
grant execute on function public.update_user_privacy_settings_v2(text, text, text, text, text, text, text) to authenticated;
grant execute on function public.get_or_create_conversation(uuid) to authenticated;
grant execute on function public.list_conversations(integer) to authenticated;
grant execute on function public.get_conversation_messages(uuid, timestamptz, integer) to authenticated;
grant execute on function public.send_direct_message(uuid, text) to authenticated;
grant execute on function public.set_conversation_read(uuid) to authenticated;
grant execute on function public.set_conversation_muted(uuid, boolean) to authenticated;
grant execute on function public.set_conversation_typing(uuid, boolean) to authenticated;
grant execute on function public.get_conversation_typing(uuid) to authenticated;
