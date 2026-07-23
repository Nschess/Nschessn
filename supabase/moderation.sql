-- Run after auth.sql and friends.sql. Safe to run more than once.
-- Player reports are private: users can submit reports but cannot read them back.

create table if not exists public.user_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  subject_user_id uuid references auth.users(id) on delete set null,
  context_type text not null check (context_type in ('friend_game', 'tournament_chat', 'friend_directory', 'other')),
  context_id text not null default '' check (length(context_id) <= 120),
  reason text not null check (length(trim(reason)) between 3 and 500),
  created_at timestamptz not null default now()
);

create index if not exists user_reports_subject_created_idx on public.user_reports (subject_user_id, created_at desc);
create index if not exists user_reports_created_idx on public.user_reports (created_at desc);
alter table public.user_reports enable row level security;
revoke all on public.user_reports from anon, authenticated;

drop function if exists public.submit_user_report(uuid, text, text, text);
create function public.submit_user_report(
  p_subject_user_id uuid,
  p_context_type text,
  p_context_id text default '',
  p_reason text default ''
)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  report_id uuid;
  clean_context text := lower(trim(coalesce(p_context_type, 'other')));
  clean_reason text := left(trim(coalesce(p_reason, '')), 500);
begin
  if auth.uid() is null then raise exception 'Sign in to submit a report'; end if;
  if p_subject_user_id is null or p_subject_user_id = auth.uid() then raise exception 'Choose another player to report'; end if;
  if clean_context not in ('friend_game', 'tournament_chat', 'friend_directory', 'other') then clean_context := 'other'; end if;
  if length(clean_reason) < 3 then raise exception 'Tell us briefly what happened'; end if;

  insert into public.user_reports (reporter_id, subject_user_id, context_type, context_id, reason)
  values (auth.uid(), p_subject_user_id, clean_context, left(trim(coalesce(p_context_id, '')), 120), clean_reason)
  returning id into report_id;
  return report_id;
end;
$$;

grant execute on function public.submit_user_report(uuid, text, text, text) to authenticated;