-- Run after supabase/auth.sql in the Supabase SQL editor.
-- Friend relationships live here; profile.friends remains a legacy local-progress snapshot.
create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sender_id, receiver_id),
  check (sender_id <> receiver_id)
);

create index if not exists friend_requests_sender_status_idx on public.friend_requests (sender_id, status);
create index if not exists friend_requests_receiver_status_idx on public.friend_requests (receiver_id, status);

alter table public.friend_requests enable row level security;
grant select on public.friend_requests to authenticated;

drop policy if exists "friend request participants read" on public.friend_requests;
create policy "friend request participants read" on public.friend_requests
  for select to authenticated using (auth.uid() = sender_id or auth.uid() = receiver_id);

create or replace function public.send_friend_request(target_user uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  request_id uuid;
  existing_status text;
begin
  if current_user_id is null then raise exception 'Sign in to add friends'; end if;
  if target_user is null or target_user = current_user_id then raise exception 'Choose another registered player'; end if;
  if not exists (select 1 from public.profiles where id = target_user) then raise exception 'That player is unavailable'; end if;

  select id, status into request_id, existing_status
  from public.friend_requests
  where (sender_id = current_user_id and receiver_id = target_user)
     or (sender_id = target_user and receiver_id = current_user_id)
  order by created_at desc
  limit 1;

  if request_id is not null and existing_status = 'accepted' then
    raise exception 'You are already friends';
  end if;

  if request_id is not null and exists (
    select 1 from public.friend_requests
    where id = request_id and sender_id = target_user and receiver_id = current_user_id and status = 'pending'
  ) then
    update public.friend_requests set status = 'accepted', updated_at = now() where id = request_id;
    return request_id;
  end if;

  if request_id is not null and exists (
    select 1 from public.friend_requests
    where id = request_id and sender_id = current_user_id and receiver_id = target_user
  ) then
    update public.friend_requests set status = 'pending', updated_at = now() where id = request_id;
    return request_id;
  end if;

  insert into public.friend_requests (sender_id, receiver_id)
  values (current_user_id, target_user)
  returning id into request_id;
  return request_id;
end;
$$;

create or replace function public.respond_to_friend_request(request_id uuid, accept_request boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.friend_requests
  set status = case when accept_request then 'accepted' else 'declined' end,
      updated_at = now()
  where id = request_id and receiver_id = auth.uid() and status = 'pending';
  if not found then raise exception 'That request is no longer waiting for you'; end if;
end;
$$;

create or replace function public.cancel_friend_request(request_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  delete from public.friend_requests
  where id = request_id and sender_id = auth.uid() and status = 'pending';
  if not found then raise exception 'That request cannot be cancelled'; end if;
end;
$$;

create or replace function public.remove_friend(target_user uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  delete from public.friend_requests
  where status = 'accepted'
    and ((sender_id = auth.uid() and receiver_id = target_user)
      or (sender_id = target_user and receiver_id = auth.uid()));
  if not found then raise exception 'That friendship no longer exists'; end if;
end;
$$;

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
  request_direction text
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
    case when request.sender_id = auth.uid() then 'outgoing' else 'incoming' end
  from public.friend_requests as request
  join public.profiles as profile
    on profile.id = case when request.sender_id = auth.uid() then request.receiver_id else request.sender_id end
  where auth.uid() is not null
    and (request.sender_id = auth.uid() or request.receiver_id = auth.uid())
    and request.status in ('pending', 'accepted')
  order by request.updated_at desc;
$$;

revoke all on function public.send_friend_request(uuid) from public;
revoke all on function public.respond_to_friend_request(uuid, boolean) from public;
revoke all on function public.cancel_friend_request(uuid) from public;
revoke all on function public.remove_friend(uuid) from public;
revoke all on function public.get_friend_directory() from public;
grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.respond_to_friend_request(uuid, boolean) to authenticated;
grant execute on function public.cancel_friend_request(uuid) to authenticated;
grant execute on function public.remove_friend(uuid) to authenticated;
grant execute on function public.get_friend_directory() to authenticated;
