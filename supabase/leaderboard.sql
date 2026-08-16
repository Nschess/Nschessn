create table if not exists public.leaderboard_entries (
  public_id text primary key check (public_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  username text not null unique check (username ~ '^[A-Za-z0-9_-]{3,20}$'),
  country_flag text not null default '',
  title text not null default '',
  puzzle_rating integer not null default 400 check (puzzle_rating between 400 and 3000),
  game_rating integer not null default 400 check (game_rating between 400 and 3000),
  achievements jsonb not null default '[]'::jsonb,
  statistics jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists leaderboard_entries_updated_public_idx
  on public.leaderboard_entries (updated_at desc, public_id asc);

alter table public.leaderboard_entries enable row level security;
grant usage on schema public to anon, authenticated;
grant select on public.leaderboard_entries to anon, authenticated;
revoke insert, update, delete on public.leaderboard_entries from anon, authenticated;

drop policy if exists "public leaderboard read" on public.leaderboard_entries;
drop policy if exists "leaderboard insert" on public.leaderboard_entries;
drop policy if exists "leaderboard update" on public.leaderboard_entries;
create policy "public leaderboard read" on public.leaderboard_entries for select using (true);

-- The leaderboard is a server-owned read model.  Ratings and statistics are
-- copied from the authoritative profile row; callers cannot submit values.
create or replace function public.sync_leaderboard_entry()
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  actor uuid := auth.uid();
  saved public.leaderboard_entries;
begin
  if actor is null then raise exception 'Sign in to sync leaderboard'; end if;
  insert into public.leaderboard_entries (
    public_id, username, country_flag, title, puzzle_rating, game_rating,
    achievements, statistics, updated_at
  )
  select profile.public_id, profile.username, profile.country_flag, profile.title,
    greatest(400, least(3000, profile.rating)), greatest(400, least(3000, profile.rating)),
    '[]'::jsonb,
    jsonb_build_object(
      'gamesPlayed', profile.wins + profile.losses + profile.draws,
      'wins', profile.wins, 'losses', profile.losses, 'draws', profile.draws
    ), now()
  from public.profiles profile
  where profile.id = actor
  on conflict (public_id) do update set
    username = excluded.username,
    country_flag = excluded.country_flag,
    title = excluded.title,
    puzzle_rating = excluded.puzzle_rating,
    game_rating = excluded.game_rating,
    achievements = excluded.achievements,
    statistics = excluded.statistics,
    updated_at = excluded.updated_at
  returning * into saved;
  if saved.public_id is null then raise exception 'Profile is unavailable'; end if;
  return to_jsonb(saved);
end;
$$;

revoke all on function public.sync_leaderboard_entry() from public;
grant execute on function public.sync_leaderboard_entry() to authenticated;
