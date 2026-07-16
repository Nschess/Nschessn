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
grant usage on schema public to anon;
grant select, insert, update on public.leaderboard_entries to anon;

drop policy if exists "public leaderboard read" on public.leaderboard_entries;
drop policy if exists "leaderboard insert" on public.leaderboard_entries;
drop policy if exists "leaderboard update" on public.leaderboard_entries;
create policy "public leaderboard read" on public.leaderboard_entries for select using (true);
create policy "leaderboard insert" on public.leaderboard_entries for insert with check (true);
create policy "leaderboard update" on public.leaderboard_entries for update using (true) with check (true);
