create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  public_id text not null unique check (public_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  username text not null unique check (username ~ '^[A-Za-z0-9_-]{3,20}$'),
  avatar text not null default 'auto',
  rating integer not null default 450 check (rating between 400 and 3000),
  coins bigint not null default 0 check (coins >= 0),
  xp bigint not null default 0 check (xp >= 0),
  wins integer not null default 0 check (wins >= 0),
  losses integer not null default 0 check (losses >= 0),
  draws integer not null default 0 check (draws >= 0),
  title text not null default '',
  friends jsonb not null default '{"friends":[]}'::jsonb,
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists avatar text not null default 'auto';
alter table public.profiles add column if not exists rating integer not null default 450;
alter table public.profiles add column if not exists coins bigint not null default 0;
alter table public.profiles add column if not exists xp bigint not null default 0;
alter table public.profiles add column if not exists wins integer not null default 0;
alter table public.profiles add column if not exists losses integer not null default 0;
alter table public.profiles add column if not exists draws integer not null default 0;
alter table public.profiles add column if not exists title text not null default '';
alter table public.profiles add column if not exists friends jsonb not null default '{"friends":[]}'::jsonb;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

alter table public.profiles enable row level security;
grant usage on schema public to anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant update on public.profiles to authenticated;

drop policy if exists "public profile lookup" on public.profiles;
drop policy if exists "profile owner update" on public.profiles;
create policy "public profile lookup" on public.profiles for select using (true);
create policy "profile owner update" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  requested_username text;
begin
  requested_username := left(regexp_replace(coalesce(new.raw_user_meta_data ->> 'username', ''), '[^A-Za-z0-9_-]', '', 'g'), 20);
  if length(requested_username) < 3 then
    requested_username := 'player_' || left(replace(new.id::text, '-', ''), 12);
  end if;
  insert into public.profiles (id, public_id, username)
  values (new.id, new.id::text, requested_username)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_profile_for_new_user();

insert into public.profiles (id, public_id, username)
select
  users.id,
  users.id::text,
  case
    when length(left(regexp_replace(coalesce(users.raw_user_meta_data ->> 'username', ''), '[^A-Za-z0-9_-]', '', 'g'), 20)) >= 3
      then left(regexp_replace(users.raw_user_meta_data ->> 'username', '[^A-Za-z0-9_-]', '', 'g'), 20)
    else 'player_' || left(replace(users.id::text, '-', ''), 12)
  end
from auth.users as users
on conflict (id) do nothing;
