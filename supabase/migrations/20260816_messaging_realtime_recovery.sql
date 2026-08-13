-- Additive cursor recovery for direct-message reconnects.
-- Existing conversation/message RPC contracts remain unchanged.

create or replace function public.get_conversation_messages_since(
  p_conversation_id uuid,
  p_since timestamptz default null,
  p_limit integer default 100
)
returns table(id uuid, sender_id uuid, sender_username text, body text, created_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare
  other_user uuid;
begin
  if auth.uid() is null or not exists (
    select 1 from public.conversation_participants
    where conversation_id = p_conversation_id and user_id = auth.uid()
  ) then
    raise exception 'Conversation is unavailable';
  end if;
  select user_id into other_user
  from public.conversation_participants
  where conversation_id = p_conversation_id and user_id <> auth.uid()
  limit 1;
  if other_user is null then raise exception 'Conversation is unavailable'; end if;
  perform public.assert_social_action(auth.uid(), other_user, 'message');
  return query
  select message.id, message.sender_id, coalesce(profile.username, 'Chess player'), message.body, message.created_at
  from public.direct_messages message
  left join public.profiles profile on profile.id = message.sender_id
  where message.conversation_id = p_conversation_id
    and message.deleted_at is null
    -- Include the cursor row itself; the client de-duplicates by message id.
    -- This prevents a same-timestamp message from being skipped during recovery.
    and (p_since is null or message.created_at >= p_since)
  order by message.created_at asc
  limit greatest(1, least(coalesce(p_limit, 100), 200));
end;
$$;

revoke all on function public.get_conversation_messages_since(uuid, timestamptz, integer) from public;
grant execute on function public.get_conversation_messages_since(uuid, timestamptz, integer) to authenticated;
