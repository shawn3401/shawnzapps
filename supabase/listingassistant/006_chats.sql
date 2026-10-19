-- Listing Assistant: the Ask tab's conversation on each lead (Shawn, Oct 19, 2026). One row per message.
-- An assistant row carries the changes it made in `actions`: [{label, undo, undone?}], where undo is what the
-- page needs to reverse it (todo_del, todo_set, item_del, form, stage). Safe to re-run.
create table if not exists public.listing_chats (
  id         bigint generated always as identity primary key,
  lead_id    uuid not null references public.listing_leads(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  role       text not null check (role in ('user','assistant')),
  text       text not null default '',
  actions    jsonb not null default '[]'
);
create index if not exists listing_chats_lead on public.listing_chats (lead_id, created_at);
alter table public.listing_chats enable row level security;
drop policy if exists listing_chats_own on public.listing_chats;
create policy listing_chats_own on public.listing_chats for all to authenticated
  using ((select auth.uid()) = user_id and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid())))
  with check ((select auth.uid()) = user_id and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid()))
              and exists (select 1 from public.listing_leads l where l.id = lead_id and l.user_id = (select auth.uid())));
revoke all on public.listing_chats from anon;
grant select, insert, update, delete on public.listing_chats to authenticated;
