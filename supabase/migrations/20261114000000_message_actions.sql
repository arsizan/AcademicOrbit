-- 14 Nov 2026: message actions in Messages.
--   * Edit: your own message, for 5 minutes after it was sent.
--   * Delete for me: hides a message only for you.
--   * Delete for everyone: your own message disappears for the whole chat.
--   * Pin / unpin: any member of the chat.
-- The rules live here, in the database, so they hold even if someone skips
-- the app. Run it once in Supabase (SQL Editor -> paste -> Run); running it
-- again changes nothing.

alter table public.messages add column if not exists edited_at timestamptz;

-- "Delete for me": which messages each person has hidden for themselves.
-- The chat is stored too, so the app can ask for one chat's list at once.
create table if not exists public.message_hidden (
  user_id uuid not null references auth.users (id) on delete cascade,
  message_id uuid not null references public.messages (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  hidden_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

create index if not exists message_hidden_message_idx on public.message_hidden (message_id);
create index if not exists message_hidden_chat_user_idx on public.message_hidden (conversation_id, user_id);

alter table public.message_hidden enable row level security;
revoke all on public.message_hidden from public, anon, authenticated;
grant select on public.message_hidden to authenticated;
grant all on public.message_hidden to service_role;

drop policy if exists "message_hidden: read own" on public.message_hidden;
create policy "message_hidden: read own" on public.message_hidden
  for select to authenticated using (user_id = (select auth.uid()));

-- Edit your own message within 5 minutes of sending it.
create or replace function public.edit_message(p_message_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.messages%rowtype;
  v_body text := btrim(coalesce(p_body, ''));
begin
  select * into m from public.messages where id = p_message_id for update;

  if not found or m.is_deleted then
    raise exception 'This message no longer exists.' using errcode = 'P0002';
  end if;
  if m.sender_id is distinct from (select auth.uid()) then
    raise exception 'You can only edit your own messages.' using errcode = '42501';
  end if;
  if m.created_at < now() - interval '5 minutes' then
    raise exception 'A message can only be edited in the first 5 minutes.' using errcode = 'P0001';
  end if;
  if v_body = '' and m.attachment_path is null then
    raise exception 'A message needs text.' using errcode = 'P0001';
  end if;
  if char_length(v_body) > 4000 then
    raise exception 'A message can be at most 4000 characters long.' using errcode = 'P0001';
  end if;

  update public.messages
  set body = nullif(v_body, ''),
      message_text = nullif(v_body, ''),
      edited_at = now(),
      updated_at = now()
  where id = p_message_id;
end;
$$;

-- Delete your own message for everyone. Returns the attachment's storage
-- path (or null), so the sender's app can remove the file too.
create or replace function public.delete_message_for_everyone(p_message_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.messages%rowtype;
begin
  select * into m from public.messages where id = p_message_id for update;

  if not found or m.is_deleted then
    return null;
  end if;
  if m.sender_id is distinct from (select auth.uid()) then
    raise exception 'You can only delete your own messages for everyone.' using errcode = '42501';
  end if;

  update public.messages
  set is_deleted = true,
      deleted_at = now(),
      body = null,
      message_text = null,
      attachment_path = null,
      attachment_name = null,
      attachment_type = null,
      attachment_size = null,
      attachment_kind = null,
      attachment_duration_seconds = null,
      pinned_at = null,
      pinned_by = null,
      updated_at = now()
  where id = p_message_id;

  return m.attachment_path;
end;
$$;

-- Hide a message only for yourself (members of its chat only).
create or replace function public.hide_message_for_me(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation uuid;
begin
  select conversation_id into v_conversation from public.messages where id = p_message_id;

  if v_conversation is null or not public.is_conversation_member(v_conversation) then
    raise exception 'This message no longer exists.' using errcode = 'P0002';
  end if;

  insert into public.message_hidden (user_id, message_id, conversation_id)
  values ((select auth.uid()), p_message_id, v_conversation)
  on conflict do nothing;
end;
$$;

-- Pin or unpin a message (any member of its chat).
create or replace function public.set_message_pinned(p_message_id uuid, p_pinned boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m public.messages%rowtype;
begin
  select * into m from public.messages where id = p_message_id for update;

  if not found or m.is_deleted or not public.is_conversation_member(m.conversation_id) then
    raise exception 'This message no longer exists.' using errcode = 'P0002';
  end if;

  update public.messages
  set pinned_at = case when p_pinned then now() else null end,
      pinned_by = case when p_pinned then (select auth.uid()) else null end,
      updated_at = now()
  where id = p_message_id;
end;
$$;

-- The chat list: same as in 20261016000000_phase4.sql, except that messages
-- I deleted for myself are not counted or shown as the last message.
create or replace function public.my_conversation_summaries()
returns table (
  conversation_id uuid,
  unread_count bigint,
  last_message_id uuid,
  last_message_body text,
  last_message_sender_id uuid,
  last_message_read_at timestamptz,
  last_message_created_at timestamptz,
  muted boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    m.conversation_id,
    (select count(*)
       from public.messages x
      where x.conversation_id = m.conversation_id
        and x.is_deleted = false
        and x.sender_id <> m.user_id
        and x.created_at > coalesce(m.last_read_at, '-infinity'::timestamptz)
        and not exists (select 1 from public.message_hidden h
                         where h.user_id = m.user_id and h.message_id = x.id)) as unread_count,
    lm.id,
    lm.body,
    lm.sender_id,
    lm.read_at,
    lm.created_at,
    coalesce(m.muted, false)
  from public.conversation_members m
  left join lateral (
    select x.id,
           coalesce(
             nullif(x.body, ''),
             nullif(x.message_text, ''),
             case x.attachment_kind
               when 'voice' then 'Voice message'
               when 'image' then 'Photo: ' || x.attachment_name
               when 'file' then 'File: ' || x.attachment_name
             end
           ) as body,
           x.sender_id, x.read_at, x.created_at
      from public.messages x
     where x.conversation_id = m.conversation_id
       and x.is_deleted = false
       and not exists (select 1 from public.message_hidden h
                        where h.user_id = m.user_id and h.message_id = x.id)
     order by x.created_at desc
     limit 1
  ) lm on true
  where m.user_id = (select auth.uid());
$$;

revoke all on function public.my_conversation_summaries() from public, anon;
grant execute on function public.my_conversation_summaries() to authenticated, service_role;

revoke all on function public.edit_message(uuid, text) from public, anon;
revoke all on function public.delete_message_for_everyone(uuid) from public, anon;
revoke all on function public.hide_message_for_me(uuid) from public, anon;
revoke all on function public.set_message_pinned(uuid, boolean) from public, anon;
grant execute on function public.edit_message(uuid, text) to authenticated, service_role;
grant execute on function public.delete_message_for_everyone(uuid) to authenticated, service_role;
grant execute on function public.hide_message_for_me(uuid) to authenticated, service_role;
grant execute on function public.set_message_pinned(uuid, boolean) to authenticated, service_role;
