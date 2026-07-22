-- Apply after supabase/auth.sql and the existing friends schema.
-- Friend presence is private: it is only returned for accepted friendships.

create table if not exists public.friend_presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  connected boolean not null default true,
  last_seen timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists friend_presence_online_idx
  on public.friend_presence (connected, last_seen desc);

alter table public.friend_presence enable row level security;

-- The return shape changes to include `online`, so recreate the RPC explicitly.
drop function if exists public.get_friend_directory();
create or replace function public.get_friend_directory()
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
  select
    request.id,
    profile.id,
    profile.username,
    profile.avatar,
    profile.rating,
    profile.title,
    profile.last_login_at,
    request.status,
    case when request.sender_id = auth.uid() then 'outgoing' else 'incoming' end,
    case when request.status = 'accepted'
      then coalesce(presence.connected and presence.last_seen > now() - interval '75 seconds', false)
      else false
    end
  from public.friend_requests as request
  join public.profiles as profile
    on profile.id = case when request.sender_id = auth.uid() then request.receiver_id else request.sender_id end
  left join public.friend_presence as presence on presence.user_id = profile.id
  where auth.uid() is not null
    and (request.sender_id = auth.uid() or request.receiver_id = auth.uid())
    and request.status in ('pending', 'accepted')
  order by request.updated_at desc;
$$;

create or replace function public.touch_friend_presence(p_connected boolean default true)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then raise exception 'Sign in to update friend presence'; end if;

  insert into public.friend_presence (user_id, connected, last_seen, updated_at)
  values (current_user_id, coalesce(p_connected, true), now(), now())
  on conflict (user_id) do update
    set connected = excluded.connected,
        last_seen = excluded.last_seen,
        updated_at = excluded.updated_at;
end;
$$;

revoke all on function public.get_friend_directory() from public;
revoke all on function public.touch_friend_presence(boolean) from public;
grant execute on function public.get_friend_directory() to authenticated;
grant execute on function public.touch_friend_presence(boolean) to authenticated;
