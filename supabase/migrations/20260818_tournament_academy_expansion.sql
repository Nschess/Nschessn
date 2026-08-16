-- Tournament scheduling, seasonal metadata, and cosmetic podium rewards.
-- Run after supabase/tournaments.sql and the Store authority migration.
-- This migration is additive and safe to re-run on an upgraded database.

begin;

do $$
begin
  if to_regclass('public.tournaments') is null
     or to_regclass('public.tournament_entries') is null
     or to_regclass('public.tournament_awards') is null then
    raise exception 'Tournament schema is required before 20260818_tournament_academy_expansion.sql';
  end if;
end;
$$;

alter table public.tournaments
  add column if not exists season_key text;

update public.tournaments
set season_key = extract(year from coalesce(starts_at, created_at))::text
  || '-S' || (floor((extract(month from coalesce(starts_at, created_at)) - 1) / 3)::integer + 1)::text
where season_key is null or btrim(season_key) = '';

alter table public.tournaments
  alter column season_key set default (extract(year from now())::text || '-S' || (floor((extract(month from now()) - 1) / 3)::integer + 1)::text),
  alter column season_key set not null;

alter table public.tournament_awards
  add column if not exists cosmetic_item_id text;

do $$
begin
  if to_regclass('public.store_catalog') is not null then
    execute $seed$
      insert into public.store_catalog (item_id, item_type, name, cost_coins, rarity, unlock_method, giftable, active, metadata, updated_at)
      values ('tournament-crown-badge', 'flexBadge', 'Tournament Crown Badge', 0, 'Legendary', 'Event', false, true,
        '{"source":"tournament","description":"A cosmetic podium badge for tournament champions."}'::jsonb, now())
      on conflict (item_id) do update set unlock_method = 'Event', giftable = false, active = true,
        metadata = excluded.metadata, updated_at = now()
    $seed$;
  end if;
end;
$$;

create index if not exists tournaments_season_status_idx
  on public.tournaments (season_key, status, starts_at desc);

create or replace function public.tournament_expanded_payload(
  p_tournament public.tournaments,
  p_viewer uuid default auth.uid()
)
returns jsonb
language plpgsql
security definer set search_path = public
stable
as $$
declare
  payload jsonb;
begin
  payload := public.tournament_payload(p_tournament, p_viewer);
  payload := jsonb_set(payload, '{seasonKey}', to_jsonb(p_tournament.season_key), true);
  payload := jsonb_set(payload, '{awards}', coalesce((
    select jsonb_agg(jsonb_build_object(
      'userId', award.user_id,
      'place', award.place,
      'coins', award.coins,
      'xp', award.xp,
      'achievement', award.achievement,
      'cosmeticItemId', award.cosmetic_item_id,
      'awardedAt', award.awarded_at
    ) order by award.place)
    from public.tournament_awards award
    where award.tournament_id = p_tournament.id
      and (award.user_id = p_viewer or p_tournament.status = 'completed')
  ), '[]'::jsonb), true);
  return payload;
end;
$$;

create or replace function public.create_tournament(
  p_title text,
  p_format text,
  p_visibility text,
  p_clock text,
  p_max_players integer,
  p_rounds integer,
  p_duration_minutes integer,
  p_starts_at timestamptz
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  created public.tournaments;
  requested_start timestamptz := p_starts_at;
begin
  if current_user_id is null then raise exception 'Sign in to create a tournament'; end if;
  if requested_start is not null and requested_start < now() + interval '60 seconds' then
    raise exception 'Scheduled start must be at least one minute from now';
  end if;
  insert into public.tournaments (
    code, creator_id, title, format, visibility, clock, max_players, rounds,
    duration_minutes, starts_at, season_key
  ) values (
    public.make_tournament_code(), current_user_id,
    left(trim(coalesce(p_title, '')), 60),
    case when p_format = 'swiss' then 'swiss' else 'arena' end,
    case when p_visibility = 'private' then 'private' else 'public' end,
    case when p_clock ~ '^[0-9]{1,3}[+][0-9]{1,3}$' then p_clock else '10+0' end,
    least(128, greatest(2, coalesce(p_max_players, 16))),
    least(9, greatest(1, coalesce(p_rounds, 3))),
    least(180, greatest(5, coalesce(p_duration_minutes, 30))),
    requested_start,
    extract(year from coalesce(requested_start, now()))::text
      || '-S' || (floor((extract(month from coalesce(requested_start, now())) - 1) / 3)::integer + 1)::text
  ) returning * into created;
  if length(created.title) < 3 then raise exception 'Tournament name needs at least 3 characters'; end if;
  insert into public.tournament_entries (tournament_id, user_id)
  values (created.id, current_user_id);
  return public.tournament_payload(created, current_user_id);
end;
$$;

create or replace function public.start_scheduled_tournaments()
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  event public.tournaments;
  player_count integer;
  started integer := 0;
begin
  for event in
    select * from public.tournaments
    where status = 'draft' and starts_at is not null and starts_at <= now()
    for update
  loop
    select count(*) into player_count
    from public.tournament_entries
    where tournament_id = event.id and not withdrawn;
    if player_count >= 2 then
      update public.tournaments
      set status = 'running', current_round = 1,
          ends_at = case when format = 'arena' then starts_at + make_interval(mins => duration_minutes) else null end,
          updated_at = now()
      where id = event.id;
      perform public.pair_tournament_players(event.id);
      started := started + 1;
    end if;
  end loop;
  return started;
end;
$$;

create or replace function public.award_tournament_finish(p_tournament_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  event public.tournaments;
  award record;
  coin_reward integer;
  xp_reward integer;
  cosmetic_item text;
  inserted_award integer;
begin
  select * into event from public.tournaments where id = p_tournament_id for update;
  if event.id is null or event.rewards_paid then return; end if;
  cosmetic_item := null;
  if to_regclass('public.store_catalog') is not null then
    execute 'select item_id from public.store_catalog where active and unlock_method = ''Event'' order by cost_coins desc, item_id limit 1' into cosmetic_item;
  end if;
  for award in
    select ranked.user_id, ranked.place
    from (
      select entry.user_id, row_number() over (order by entry.score desc, entry.wins desc, entry.draws desc, entry.joined_at) as place
      from public.tournament_entries entry
      where entry.tournament_id = event.id and not entry.withdrawn
    ) ranked where ranked.place <= 3
  loop
    coin_reward := case award.place when 1 then 300 when 2 then 160 else 90 end;
    xp_reward := case award.place when 1 then 180 when 2 then 100 else 60 end;
    insert into public.tournament_awards (
      tournament_id, user_id, place, coins, xp, achievement, cosmetic_item_id
    ) values (
      event.id, award.user_id, award.place, coin_reward, xp_reward,
      case award.place when 1 then 'Tournament Champion' when 2 then 'Tournament Finalist' else 'Tournament Podium' end,
      cosmetic_item
    ) on conflict (tournament_id, user_id) do nothing;
    get diagnostics inserted_award = row_count;
    if inserted_award = 1 then
      update public.profiles
      set coins = coins + coin_reward, xp = xp + xp_reward, updated_at = now()
      where id = award.user_id;
      if cosmetic_item is not null and to_regclass('public.user_inventory') is not null then
        execute 'insert into public.user_inventory(user_id, item_id, source) values ($1, $2, ''event'') on conflict (user_id, item_id) do nothing'
          using award.user_id, cosmetic_item;
      end if;
    end if;
  end loop;
  update public.tournaments set rewards_paid = true, updated_at = now() where id = event.id;
end;
$$;

create or replace function public.list_tournaments()
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  result jsonb;
begin
  if current_user_id is null then raise exception 'Sign in to view tournaments'; end if;
  perform public.start_scheduled_tournaments();
  perform public.expire_tournaments();
  select coalesce(jsonb_agg(public.tournament_expanded_payload(tournament, current_user_id) order by tournament.status = 'running' desc, tournament.created_at desc), '[]'::jsonb)
  into result
  from public.tournaments tournament
  where tournament.visibility = 'public'
     or tournament.creator_id = current_user_id
     or exists (select 1 from public.tournament_entries entry where entry.tournament_id = tournament.id and entry.user_id = current_user_id)
     or exists (select 1 from public.tournament_invites invite where invite.tournament_id = tournament.id and invite.receiver_id = current_user_id);
  return result;
end;
$$;

create or replace function public.get_tournament(p_code text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  event public.tournaments;
begin
  if current_user_id is null then raise exception 'Sign in to open a tournament'; end if;
  perform public.start_scheduled_tournaments();
  perform public.expire_tournaments();
  select * into event from public.tournaments where code = upper(trim(p_code));
  if event.id is null then raise exception 'Tournament not found'; end if;
  if event.visibility = 'private'
    and event.creator_id <> current_user_id
    and not exists (select 1 from public.tournament_entries where tournament_id = event.id and user_id = current_user_id)
    and not exists (select 1 from public.tournament_invites where tournament_id = event.id and receiver_id = current_user_id) then
    raise exception 'This private tournament requires an invite';
  end if;
  return public.tournament_expanded_payload(event, current_user_id);
end;
$$;

revoke all on function public.create_tournament(text, text, text, text, integer, integer, integer, timestamptz) from public;
grant execute on function public.create_tournament(text, text, text, text, integer, integer, integer, timestamptz) to authenticated;
revoke all on function public.start_scheduled_tournaments() from public;
revoke all on function public.tournament_expanded_payload(public.tournaments, uuid) from public;

commit;
