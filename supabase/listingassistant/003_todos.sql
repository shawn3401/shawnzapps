-- Listing Assistant: the running to-do list on a lead (Shawn, Oct 13, 2026): what has to happen before the
-- home goes live. Rows are typed by the agent (source 'me') or found by the listing-todos function in a note,
-- transcript, or PDF (source 'ai', item_id = the entry it came from). done_hint is the AI saying new material
-- shows an open to-do is finished; the agent confirms it, nothing is ticked off automatically. Safe to re-run.
create table if not exists public.listing_todos (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.listing_leads(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  text       text not null,
  who        text not null default '',
  done       boolean not null default false,
  done_at    timestamptz,
  source     text not null default 'me' check (source in ('me','ai')),
  item_id    uuid references public.listing_items(id) on delete set null,
  done_hint  text not null default ''
);
create index if not exists listing_todos_lead on public.listing_todos (lead_id, created_at);
create index if not exists listing_todos_user_open on public.listing_todos (user_id) where not done;
alter table public.listing_todos enable row level security;
drop policy if exists listing_todos_own on public.listing_todos;
create policy listing_todos_own on public.listing_todos for all to authenticated
  using ((select auth.uid()) = user_id and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid())))
  with check ((select auth.uid()) = user_id and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid()))
              and exists (select 1 from public.listing_leads l where l.id = lead_id and l.user_id = (select auth.uid())));
revoke all on public.listing_todos from anon;
grant select, insert, update, delete on public.listing_todos to authenticated;

-- Every note saved now makes an AI call, and all calls share one daily cap, so the cap went from 60 to 500.
update public.listing_access set daily_limit = 500 where daily_limit < 500;
