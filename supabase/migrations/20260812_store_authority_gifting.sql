-- Server-authoritative cosmetic economy and gifting.
-- Apply after 20260812_strengthen_friend_security.sql and
-- 20260812_messaging_privacy.sql.

create table if not exists public.store_catalog (
  item_id text primary key check (length(item_id) between 1 and 96),
  item_type text not null check (item_type in (
    'board', 'skin', 'pieceFinish', 'backgroundTheme', 'avatar', 'avatarEffect',
    'frame', 'nameStyle', 'lastMove', 'boardBorder', 'archetype', 'musicPack',
    'sfxPack', 'title', 'trail', 'flexBadge'
  )),
  name text not null check (length(name) between 1 and 120),
  cost_coins bigint not null default 0 check (cost_coins >= 0),
  rarity text not null check (rarity in ('Common', 'Rare', 'Epic', 'Legendary', 'Mythic', 'Divine')),
  unlock_method text not null default 'Coins' check (unlock_method in ('Coins', 'Achievement', 'Season', 'Event')),
  giftable boolean not null default true,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('purchase', 'gift_purchase', 'gift_refund')),
  status text not null default 'completed' check (status in ('completed', 'refunded', 'void')),
  idempotency_key text not null check (length(idempotency_key) between 8 and 128),
  total_coins bigint not null default 0 check (total_coins >= 0),
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create table if not exists public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  transaction_id uuid references public.transactions(id) on delete set null,
  delta_coins bigint not null,
  balance_after bigint not null check (balance_after >= 0),
  reason text not null check (length(reason) between 1 and 80),
  idempotency_key text,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create table if not exists public.user_inventory (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null references public.store_catalog(item_id),
  source text not null check (source in ('purchase', 'achievement', 'season', 'event', 'gift', 'migration')),
  transaction_id uuid references public.transactions(id) on delete set null,
  equipped boolean not null default false,
  acquired_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create table if not exists public.purchase_history (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  buyer_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null references public.store_catalog(item_id),
  recipient_id uuid references auth.users(id) on delete set null,
  unit_cost bigint not null check (unit_cost >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.gifts (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  item_id text not null references public.store_catalog(item_id),
  transaction_id uuid not null references public.transactions(id) on delete restrict,
  message text not null default '' check (length(message) <= 240),
  status text not null default 'pending' check (status in ('pending', 'claimed', 'declined', 'expired')),
  idempotency_key text not null check (length(idempotency_key) between 8 and 128),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  resolved_at timestamptz,
  unique (sender_id, idempotency_key),
  check (sender_id <> recipient_id)
);

create index if not exists user_inventory_user_idx on public.user_inventory(user_id, acquired_at desc);
create index if not exists wallet_ledger_user_idx on public.wallet_ledger(user_id, created_at desc);
create index if not exists transactions_user_idx on public.transactions(user_id, created_at desc);
create index if not exists purchase_history_buyer_idx on public.purchase_history(buyer_id, created_at desc);
create index if not exists gifts_recipient_idx on public.gifts(recipient_id, status, created_at desc);
create index if not exists gifts_sender_idx on public.gifts(sender_id, created_at desc);

alter table public.store_catalog enable row level security;
alter table public.user_inventory enable row level security;
alter table public.transactions enable row level security;
alter table public.wallet_ledger enable row level security;
alter table public.purchase_history enable row level security;
alter table public.gifts enable row level security;

drop policy if exists store_catalog_read on public.store_catalog;
create policy store_catalog_read on public.store_catalog for select to authenticated using (active);
drop policy if exists user_inventory_owner_read on public.user_inventory;
create policy user_inventory_owner_read on public.user_inventory for select to authenticated using (user_id = auth.uid());
drop policy if exists gifts_participant_read on public.gifts;
create policy gifts_participant_read on public.gifts for select to authenticated using (sender_id = auth.uid() or recipient_id = auth.uid());
revoke all on table public.store_catalog, public.user_inventory, public.transactions, public.wallet_ledger, public.purchase_history, public.gifts from anon, authenticated;
grant select on public.store_catalog, public.user_inventory, public.gifts to authenticated;

-- The legacy profile policy grants authenticated users profile updates for
-- preferences and progress. Remove broad UPDATE privileges so the wallet
-- column can only be changed by the security-definer Store/game RPCs.
revoke update on public.profiles from authenticated;
grant update (avatar, country_flag, title, friends, last_login_at, updated_at)
  on public.profiles to authenticated;

create or replace function public.get_store_state()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare current_user_id uuid := auth.uid(); wallet bigint; inventory jsonb; catalog jsonb;
begin
  if current_user_id is null then raise exception 'Sign in to open the Store'; end if;
  select coins into wallet from public.profiles where id = current_user_id;
  if wallet is null then raise exception 'Player wallet is unavailable'; end if;
  -- Zero-cost coin cosmetics are the catalog's starter loadout. Grant them
  -- once through the server so authenticated clients never invent ownership in
  -- local storage and every account starts with a usable board/profile style.
  insert into public.user_inventory(user_id, item_id, source)
    select current_user_id, item.item_id, 'migration'
    from public.store_catalog item
    where item.active and item.unlock_method = 'Coins' and item.cost_coins = 0
    on conflict (user_id, item_id) do nothing;
  inventory := coalesce((select jsonb_agg(jsonb_build_object('itemId', item.item_id, 'source', item.source, 'equipped', item.equipped, 'acquiredAt', item.acquired_at) order by item.acquired_at desc)
    from public.user_inventory item where item.user_id = current_user_id), '[]'::jsonb);
  catalog := coalesce((select jsonb_agg(to_jsonb(item) order by item.name) from public.store_catalog item where item.active), '[]'::jsonb);
  return jsonb_build_object('coins', wallet, 'inventory', inventory, 'catalog', catalog);
end;
$$;

create or replace function public.equip_cosmetic(p_item_id text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare current_user_id uuid := auth.uid(); item public.store_catalog;
begin
  if current_user_id is null then raise exception 'Sign in to equip cosmetics'; end if;
  select * into item from public.store_catalog where item_id = p_item_id and active;
  if not found then raise exception 'Cosmetic is unavailable'; end if;
  if not exists (select 1 from public.user_inventory where user_id = current_user_id and item_id = p_item_id) then raise exception 'Cosmetic is not owned'; end if;
  update public.user_inventory owned set equipped = false
    from public.store_catalog catalog
    where owned.user_id = current_user_id and owned.equipped and owned.item_id = catalog.item_id and catalog.item_type = item.item_type;
  update public.user_inventory set equipped = true where user_id = current_user_id and item_id = p_item_id;
  return jsonb_build_object('itemId', p_item_id, 'itemType', item.item_type);
end;
$$;

create or replace function public.credit_store_reward(p_amount bigint, p_reason text, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare current_user_id uuid := auth.uid(); balance bigint; reward_reason text;
begin
  if current_user_id is null then raise exception 'Sign in to claim rewards'; end if;
  if p_amount < 1 or p_amount > 5000 or length(trim(coalesce(p_reason, ''))) < 1 or length(trim(coalesce(p_reason, ''))) > 80 then raise exception 'Reward is invalid'; end if;
  if lower(trim(p_reason)) not in ('gameplay reward', 'puzzle reward', 'lesson reward', 'video reward', 'daily reward', 'achievement reward') then raise exception 'Reward source is invalid'; end if;
  if lower(trim(p_reason)) <> 'achievement reward' and p_amount > 100 then raise exception 'Reward amount is invalid'; end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 then raise exception 'Reward request is missing an idempotency key'; end if;
  reward_reason := 'store reward:' || lower(trim(p_reason));
  if exists (select 1 from public.wallet_ledger where user_id = current_user_id and idempotency_key = p_idempotency_key) then
    select coins into balance from public.profiles where id = current_user_id;
    return jsonb_build_object('coins', balance, 'replayed', true);
  end if;
  perform public.consume_social_rate_limit('wallet_reward', 40, 86400);
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));
  if exists (select 1 from public.wallet_ledger where user_id = current_user_id and idempotency_key = p_idempotency_key) then
    select coins into balance from public.profiles where id = current_user_id;
    return jsonb_build_object('coins', balance, 'replayed', true);
  end if;
  select coins into balance from public.profiles where id = current_user_id for update;
  if coalesce((select sum(delta_coins) from public.wallet_ledger where user_id = current_user_id and delta_coins > 0 and reason like 'store reward:%' and created_at >= date_trunc('day', now())), 0) + p_amount > 5000 then
    raise exception 'Daily reward limit reached';
  end if;
  update public.profiles set coins = coins + p_amount, updated_at = now() where id = current_user_id returning coins into balance;
  insert into public.wallet_ledger(user_id, delta_coins, balance_after, reason, idempotency_key)
    values (current_user_id, p_amount, balance, reward_reason, p_idempotency_key)
    on conflict (user_id, idempotency_key) do nothing;
  return jsonb_build_object('coins', balance);
end;
$$;

create or replace function public.purchase_cosmetic(p_item_id text, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare current_user_id uuid := auth.uid(); item public.store_catalog; tx public.transactions; balance bigint; existing public.transactions;
begin
  if current_user_id is null then raise exception 'Sign in to purchase cosmetics'; end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 then raise exception 'Purchase request is missing an idempotency key'; end if;
  select * into existing from public.transactions where user_id = current_user_id and idempotency_key = p_idempotency_key limit 1;
  if found then return jsonb_build_object('transactionId', existing.id, 'coins', (select coins from public.profiles where id = current_user_id), 'itemId', p_item_id, 'replayed', true); end if;
  -- Purchasing is independent from gifting. Some cosmetics may be intentionally
  -- non-giftable while remaining valid coin purchases.
  select * into item from public.store_catalog where item_id = p_item_id and active and unlock_method = 'Coins';
  if not found then raise exception 'Cosmetic is not purchasable'; end if;
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));
  select * into existing from public.transactions where user_id = current_user_id and idempotency_key = p_idempotency_key limit 1;
  if found then return jsonb_build_object('transactionId', existing.id, 'coins', (select coins from public.profiles where id = current_user_id), 'itemId', p_item_id, 'replayed', true); end if;
  if exists (select 1 from public.user_inventory where user_id = current_user_id and item_id = item.item_id) then raise exception 'Cosmetic already owned'; end if;
  select coins into balance from public.profiles where id = current_user_id for update;
  if balance < item.cost_coins then raise exception 'Not enough coins'; end if;
  update public.profiles set coins = coins - item.cost_coins, updated_at = now() where id = current_user_id returning coins into balance;
  insert into public.transactions(user_id, kind, idempotency_key, total_coins) values (current_user_id, 'purchase', p_idempotency_key, item.cost_coins) returning * into tx;
  insert into public.wallet_ledger(user_id, transaction_id, delta_coins, balance_after, reason, idempotency_key) values (current_user_id, tx.id, -item.cost_coins, balance, 'cosmetic purchase', p_idempotency_key);
  insert into public.user_inventory(user_id, item_id, source, transaction_id) values (current_user_id, item.item_id, 'purchase', tx.id);
  insert into public.purchase_history(transaction_id, buyer_id, item_id, unit_cost) values (tx.id, current_user_id, item.item_id, item.cost_coins);
  return jsonb_build_object('transactionId', tx.id, 'coins', balance, 'itemId', item.item_id, 'replayed', false);
end;
$$;

create or replace function public.purchase_cosmetic_bundle(p_item_ids text[], p_discount numeric, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare current_user_id uuid := auth.uid(); tx public.transactions; balance bigint; raw_total bigint; total bigint; item_count integer; missing_count integer; existing public.transactions;
begin
  if current_user_id is null then raise exception 'Sign in to purchase cosmetics'; end if;
  if p_item_ids is null or cardinality(p_item_ids) < 1 or cardinality(p_item_ids) > 12 then raise exception 'Bundle is invalid'; end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 then raise exception 'Purchase request is missing an idempotency key'; end if;
  select * into existing from public.transactions where user_id = current_user_id and idempotency_key = p_idempotency_key limit 1;
  if found then return jsonb_build_object('transactionId', existing.id, 'coins', (select coins from public.profiles where id = current_user_id), 'replayed', true); end if;
  if coalesce(p_discount, 0) < 0.15 or coalesce(p_discount, 0) > 0.25 then raise exception 'Bundle discount is invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));
  select * into existing from public.transactions where user_id = current_user_id and idempotency_key = p_idempotency_key limit 1;
  if found then return jsonb_build_object('transactionId', existing.id, 'coins', (select coins from public.profiles where id = current_user_id), 'replayed', true); end if;
  select count(distinct catalog.item_id), count(distinct catalog.item_id) filter (where owned.item_id is null), coalesce(sum(catalog.cost_coins) filter (where owned.item_id is null), 0)
    into item_count, missing_count, raw_total
    from public.store_catalog catalog
    left join public.user_inventory owned on owned.user_id = current_user_id and owned.item_id = catalog.item_id
    where catalog.item_id = any(p_item_ids) and catalog.active and catalog.unlock_method = 'Coins';
  if item_count <> cardinality(p_item_ids) then raise exception 'Bundle contains unavailable cosmetics'; end if;
  if missing_count = 0 then return jsonb_build_object('coins', (select coins from public.profiles where id = current_user_id), 'replayed', true, 'complete', true); end if;
  total := floor(raw_total * (1 - p_discount));
  select coins into balance from public.profiles where id = current_user_id for update;
  if balance < total then raise exception 'Not enough coins'; end if;
  update public.profiles set coins = coins - total, updated_at = now() where id = current_user_id returning coins into balance;
  insert into public.transactions(user_id, kind, idempotency_key, total_coins) values (current_user_id, 'purchase', p_idempotency_key, total) returning * into tx;
  insert into public.wallet_ledger(user_id, transaction_id, delta_coins, balance_after, reason, idempotency_key) values (current_user_id, tx.id, -total, balance, 'cosmetic bundle purchase', p_idempotency_key);
  insert into public.purchase_history(transaction_id, buyer_id, item_id, unit_cost)
    select tx.id, current_user_id, catalog.item_id, catalog.cost_coins
    from public.store_catalog catalog
    left join public.user_inventory owned on owned.user_id = current_user_id and owned.item_id = catalog.item_id
    where catalog.item_id = any(p_item_ids) and owned.item_id is null;
  insert into public.user_inventory(user_id, item_id, source, transaction_id)
    select current_user_id, catalog.item_id, 'purchase', tx.id from public.store_catalog catalog
    left join public.user_inventory owned on owned.user_id = current_user_id and owned.item_id = catalog.item_id
    where catalog.item_id = any(p_item_ids) and owned.item_id is null;
  return jsonb_build_object('transactionId', tx.id, 'coins', balance, 'replayed', false, 'savings', raw_total - total);
end;
$$;

create or replace function public.list_gift_inbox(p_limit integer default 40)
returns table(id uuid, sender_id uuid, sender_username text, item_id text, item_name text, item_type text, message text, status text, created_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare gift_row public.gifts; tx public.transactions; balance bigint; refund_key text;
begin
  if auth.uid() is null then raise exception 'Sign in to view gifts'; end if;
  for gift_row in select * from public.gifts where recipient_id = auth.uid() and status = 'pending' and expires_at <= now() for update loop
    perform pg_advisory_xact_lock(hashtextextended(gift_row.sender_id::text, 0));
    select * into tx from public.transactions where id = gift_row.transaction_id for update;
    select coins into balance from public.profiles where id = gift_row.sender_id for update;
    update public.profiles set coins = coins + tx.total_coins, updated_at = now() where id = gift_row.sender_id returning coins into balance;
    update public.transactions set status = 'refunded' where id = tx.id;
    refund_key := 'gift-expiry:' || gift_row.id::text;
    insert into public.wallet_ledger(user_id, transaction_id, delta_coins, balance_after, reason, idempotency_key)
      values (gift_row.sender_id, tx.id, tx.total_coins, balance, 'expired cosmetic gift refund', refund_key) on conflict do nothing;
    update public.gifts set status = 'expired', resolved_at = now() where id = gift_row.id;
  end loop;
  return query select gift.id, gift.sender_id, coalesce(profile.username, 'Chess player'), gift.item_id, catalog.name, catalog.item_type, gift.message, gift.status, gift.created_at, gift.expires_at
    from public.gifts gift join public.store_catalog catalog on catalog.item_id = gift.item_id
    left join public.profiles profile on profile.id = gift.sender_id
    where gift.recipient_id = auth.uid()
    order by gift.created_at desc limit greatest(1, least(coalesce(p_limit, 40), 100));
end;
$$;

create or replace function public.create_cosmetic_gift(p_recipient_id text, p_item_id text, p_message text, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare current_user_id uuid := auth.uid(); recipient_id uuid; item public.store_catalog; tx public.transactions; gift public.gifts; balance bigint; existing public.gifts;
begin
  if current_user_id is null then raise exception 'Sign in to send gifts'; end if;
  -- Accept the public ID, username, or auth UUID shown by the Friends hub,
  -- then resolve it once on the server. The client never chooses a recipient
  -- UUID or bypasses the relationship checks below.
  select profile.id into recipient_id
  from public.profiles profile
  where profile.public_id = nullif(trim(p_recipient_id), '')
     or profile.username = nullif(trim(p_recipient_id), '')
     or profile.id::text = nullif(trim(p_recipient_id), '')
  limit 1;
  if recipient_id is null or recipient_id = current_user_id then raise exception 'Choose another player'; end if;
  if length(trim(coalesce(p_idempotency_key, ''))) < 8 then raise exception 'Gift request is missing an idempotency key'; end if;
  select * into existing from public.gifts where sender_id = current_user_id and idempotency_key = p_idempotency_key limit 1;
  if found then return jsonb_build_object('giftId', existing.id, 'status', existing.status, 'replayed', true); end if;
  if public.is_social_blocked(current_user_id, recipient_id) then raise exception 'This player is unavailable'; end if;
  select * into item from public.store_catalog where item_id = p_item_id and active and unlock_method = 'Coins' and giftable;
  if not found then raise exception 'Only purchasable cosmetics can be gifted'; end if;
  perform pg_advisory_xact_lock(hashtextextended(current_user_id::text, 0));
  select * into existing from public.gifts where sender_id = current_user_id and idempotency_key = p_idempotency_key limit 1;
  if found then return jsonb_build_object('giftId', existing.id, 'status', existing.status, 'replayed', true); end if;
  select coins into balance from public.profiles where id = current_user_id for update;
  if balance < item.cost_coins then raise exception 'Not enough coins'; end if;
  update public.profiles set coins = coins - item.cost_coins, updated_at = now() where id = current_user_id returning coins into balance;
  insert into public.transactions(user_id, kind, idempotency_key, total_coins) values (current_user_id, 'gift_purchase', p_idempotency_key, item.cost_coins) returning * into tx;
  insert into public.wallet_ledger(user_id, transaction_id, delta_coins, balance_after, reason, idempotency_key) values (current_user_id, tx.id, -item.cost_coins, balance, 'cosmetic gift', p_idempotency_key);
  insert into public.purchase_history(transaction_id, buyer_id, item_id, recipient_id, unit_cost) values (tx.id, current_user_id, item.item_id, recipient_id, item.cost_coins);
  insert into public.gifts(sender_id, recipient_id, item_id, transaction_id, message, idempotency_key) values (current_user_id, recipient_id, item.item_id, tx.id, left(trim(coalesce(p_message, '')), 240), p_idempotency_key) returning * into gift;
  perform public.create_social_notification(recipient_id, current_user_id, 'gift_received', gift.id, null, jsonb_build_object('itemId', item.item_id));
  return jsonb_build_object('giftId', gift.id, 'transactionId', tx.id, 'coins', balance, 'status', gift.status, 'replayed', false);
end;
$$;

create or replace function public.claim_cosmetic_gift(p_gift_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare gift public.gifts; item public.store_catalog; tx public.transactions; balance bigint;
begin
  if auth.uid() is null then raise exception 'Sign in to claim gifts'; end if;
  select * into gift from public.gifts where id = p_gift_id and recipient_id = auth.uid() for update;
  if not found then raise exception 'Gift is unavailable'; end if;
  if gift.status = 'claimed' then return jsonb_build_object('giftId', gift.id, 'status', 'claimed', 'replayed', true); end if;
  if gift.status <> 'pending' or gift.expires_at <= now() then
    if gift.status = 'pending' then
      perform pg_advisory_xact_lock(hashtextextended(gift.sender_id::text, 0));
      select * into tx from public.transactions where id = gift.transaction_id for update;
      select coins into balance from public.profiles where id = gift.sender_id for update;
      update public.profiles set coins = coins + tx.total_coins, updated_at = now() where id = gift.sender_id returning coins into balance;
      update public.transactions set status = 'refunded' where id = tx.id;
      insert into public.wallet_ledger(user_id, transaction_id, delta_coins, balance_after, reason, idempotency_key)
        values (gift.sender_id, tx.id, tx.total_coins, balance, 'expired cosmetic gift refund', 'gift-expiry:' || gift.id::text) on conflict do nothing;
      update public.gifts set status = 'expired', resolved_at = now() where id = gift.id;
    end if;
    raise exception 'Gift has expired';
  end if;
  select * into item from public.store_catalog where item_id = gift.item_id and active;
  if not found then raise exception 'Gift cosmetic is unavailable'; end if;
  insert into public.user_inventory(user_id, item_id, source, transaction_id) values (auth.uid(), gift.item_id, 'gift', gift.transaction_id) on conflict do nothing;
  update public.gifts set status = 'claimed', resolved_at = now() where id = gift.id;
  return jsonb_build_object('giftId', gift.id, 'itemId', gift.item_id, 'status', 'claimed', 'replayed', false);
end;
$$;

create or replace function public.decline_cosmetic_gift(p_gift_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare gift public.gifts; balance bigint; tx public.transactions; refund_key text;
begin
  if auth.uid() is null then raise exception 'Sign in to decline gifts'; end if;
  select * into gift from public.gifts where id = p_gift_id and recipient_id = auth.uid() for update;
  if not found then raise exception 'Gift is unavailable'; end if;
  if gift.status <> 'pending' then return jsonb_build_object('giftId', gift.id, 'status', gift.status, 'replayed', true); end if;
  refund_key := 'gift-refund:' || gift.id::text;
  perform pg_advisory_xact_lock(hashtextextended(gift.sender_id::text, 0));
  select * into tx from public.transactions where id = gift.transaction_id for update;
  select coins into balance from public.profiles where id = gift.sender_id for update;
  update public.profiles set coins = coins + tx.total_coins, updated_at = now() where id = gift.sender_id returning coins into balance;
  update public.transactions set status = 'refunded' where id = tx.id;
  insert into public.wallet_ledger(user_id, transaction_id, delta_coins, balance_after, reason, idempotency_key) values (gift.sender_id, tx.id, tx.total_coins, balance, 'declined cosmetic gift refund', refund_key) on conflict do nothing;
  update public.gifts set status = 'declined', resolved_at = now() where id = gift.id;
  return jsonb_build_object('giftId', gift.id, 'status', 'declined', 'replayed', false);
end;
$$;

-- Deployment tooling may seed the catalog from the checked-in cosmetic catalog.
-- It is deliberately service-role only; clients cannot define prices or items.
create or replace function public.admin_upsert_store_catalog(p_rows jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare row_count integer;
begin
  if auth.role() <> 'service_role' then raise exception 'Admin catalog access required'; end if;
  insert into public.store_catalog(item_id, item_type, name, cost_coins, rarity, unlock_method, giftable, active, metadata, updated_at)
  select row.item_id, row.item_type, row.name, row.cost_coins, row.rarity, row.unlock_method, coalesce(row.giftable, true), coalesce(row.active, true), coalesce(row.metadata, '{}'::jsonb), now()
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as row(item_id text, item_type text, name text, cost_coins bigint, rarity text, unlock_method text, giftable boolean, active boolean, metadata jsonb)
  on conflict (item_id) do update set item_type = excluded.item_type, name = excluded.name, cost_coins = excluded.cost_coins, rarity = excluded.rarity, unlock_method = excluded.unlock_method, giftable = excluded.giftable, active = excluded.active, metadata = excluded.metadata, updated_at = now();
  get diagnostics row_count = row_count;
  return row_count;
end;
$$;

revoke all on function public.get_store_state() from public;
revoke all on function public.equip_cosmetic(text) from public;
revoke all on function public.credit_store_reward(bigint, text, text) from public;
revoke all on function public.purchase_cosmetic(text, text) from public;
revoke all on function public.purchase_cosmetic_bundle(text[], numeric, text) from public;
revoke all on function public.list_gift_inbox(integer) from public;
revoke all on function public.create_cosmetic_gift(text, text, text, text) from public;
revoke all on function public.claim_cosmetic_gift(uuid) from public;
revoke all on function public.decline_cosmetic_gift(uuid) from public;
revoke all on function public.admin_upsert_store_catalog(jsonb) from public;
grant execute on function public.get_store_state() to authenticated;
grant execute on function public.equip_cosmetic(text) to authenticated;
grant execute on function public.credit_store_reward(bigint, text, text) to service_role;
grant execute on function public.purchase_cosmetic(text, text) to authenticated;
grant execute on function public.purchase_cosmetic_bundle(text[], numeric, text) to authenticated;
grant execute on function public.list_gift_inbox(integer) to authenticated;
grant execute on function public.create_cosmetic_gift(text, text, text, text) to authenticated;
grant execute on function public.claim_cosmetic_gift(uuid) to authenticated;
grant execute on function public.decline_cosmetic_gift(uuid) to authenticated;
grant execute on function public.admin_upsert_store_catalog(jsonb) to service_role;
