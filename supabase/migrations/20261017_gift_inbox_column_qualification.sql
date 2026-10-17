-- Qualify table columns that share RETURNS TABLE output parameter names.
-- Preserves the function signature, auth guard and refund behavior.
create or replace function public.list_gift_inbox(p_limit integer default 40)
returns table(id uuid, sender_id uuid, sender_username text, item_id text, item_name text, item_type text, message text, status text, created_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare gift_row public.gifts; tx public.transactions; balance bigint; refund_key text;
begin
  if auth.uid() is null then raise exception 'Sign in to view gifts'; end if;
  for gift_row in select g.* from public.gifts g where g.recipient_id = auth.uid() and g.status = 'pending' and g.expires_at <= now() for update loop
    perform pg_advisory_xact_lock(hashtextextended(gift_row.sender_id::text, 0));
    select t.* into tx from public.transactions t where t.id = gift_row.transaction_id for update;
    select p.coins into balance from public.profiles p where p.id = gift_row.sender_id for update;
    update public.profiles p set coins = p.coins + tx.total_coins, updated_at = now() where p.id = gift_row.sender_id returning p.coins into balance;
    update public.transactions t set status = 'refunded' where t.id = tx.id;
    refund_key := 'gift-expiry:' || gift_row.id::text;
    insert into public.wallet_ledger(user_id, transaction_id, delta_coins, balance_after, reason, idempotency_key)
      values (gift_row.sender_id, tx.id, tx.total_coins, balance, 'expired cosmetic gift refund', refund_key) on conflict do nothing;
    update public.gifts g set status = 'expired', resolved_at = now() where g.id = gift_row.id;
  end loop;
  return query select gift.id, gift.sender_id, coalesce(profile.username, 'Chess player'), gift.item_id, catalog.name, catalog.item_type, gift.message, gift.status, gift.created_at, gift.expires_at
    from public.gifts gift join public.store_catalog catalog on catalog.item_id = gift.item_id
    left join public.profiles profile on profile.id = gift.sender_id
    where gift.recipient_id = auth.uid()
    order by gift.created_at desc limit greatest(1, least(coalesce(p_limit, 40), 100));
end;
$$;


-- This inbox is authenticated-only; remove any restored explicit anon grant.
revoke all on function public.list_gift_inbox(integer) from public, anon;
grant execute on function public.list_gift_inbox(integer) to authenticated;
