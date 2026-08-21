-- Social providers do not guarantee a product-safe username. Reuse the
-- existing auth.users trigger and make its metadata handling deterministic,
-- safe, and collision-resistant for OAuth and password registrations alike.
create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  requested_username text;
  fallback_suffix text;
begin
  fallback_suffix := left(replace(new.id::text, '-', ''), 12);
  requested_username := left(regexp_replace(coalesce(
    nullif(new.raw_user_meta_data ->> 'username', ''),
    nullif(new.raw_user_meta_data ->> 'preferred_username', ''),
    nullif(new.raw_user_meta_data ->> 'user_name', ''),
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'name', ''),
    ''
  ), '[^A-Za-z0-9_-]', '', 'g'), 20);
  if length(requested_username) < 3 then
    requested_username := 'player_' || fallback_suffix;
  end if;
  if exists (select 1 from public.profiles where lower(username) = lower(requested_username) and id <> new.id) then
    requested_username := left(requested_username, 13) || '_' || left(fallback_suffix, 6);
  end if;
  if exists (select 1 from public.profiles where lower(username) = lower(requested_username) and id <> new.id) then
    requested_username := 'player_' || fallback_suffix;
  end if;

  insert into public.profiles (id, public_id, username)
  values (new.id, new.id::text, requested_username)
  on conflict (id) do nothing;
  return new;
end;
$$;
