-- Social dependency foundation.
--
-- The dated 20260812 migrations are intentionally kept backwards compatible
-- with installations that already ran the legacy SQL files.  This small
-- prerequisite migration makes their declared dependency order deterministic:
-- messaging, activity, and Store migrations can safely be applied in filename
-- order before the later hardening migration redefines the same functions.

begin;

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

create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

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

create index if not exists user_blocks_blocked_idx
  on public.user_blocks (blocked_id, blocker_id);
create index if not exists social_notifications_recipient_idx
  on public.social_notifications (recipient_id, read_at, created_at desc);

alter table public.user_privacy_settings enable row level security;
alter table public.user_blocks enable row level security;
alter table public.social_rate_limits enable row level security;
alter table public.social_notifications enable row level security;
revoke all on table public.user_privacy_settings, public.user_blocks, public.social_rate_limits from anon, authenticated;
revoke all on table public.social_notifications from anon, authenticated;

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

revoke all on function public.is_social_blocked(uuid, uuid) from public;
revoke all on function public.is_social_friend(uuid, uuid) from public;
revoke all on function public.social_action_allowed(uuid, uuid, text) from public;
revoke all on function public.create_social_notification(uuid, uuid, text, uuid, text, jsonb) from public;

commit;
