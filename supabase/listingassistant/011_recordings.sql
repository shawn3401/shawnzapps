-- Listing Assistant: Granola recordings inbox (Oct 24, 2026). Applied as migration listing_011_recordings. Safe to re-run.
-- listing_granola holds each person's Granola API key; only the listing-granola Edge Function (service role) reads it.
create table if not exists public.listing_granola (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  api_key     text not null,
  connected_at timestamptz not null default now(),
  last_sync   timestamptz,
  last_error  text not null default ''
);
alter table public.listing_granola enable row level security;
revoke all on public.listing_granola from anon, authenticated;

create table if not exists public.listing_recordings (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  source       text not null default 'granola',
  source_id    text not null,
  title        text not null default '',
  recorded_at  timestamptz,
  minutes      int,
  summary      text not null default '',
  transcript   text not null default '',
  attendees    jsonb not null default '[]',
  web_url      text not null default '',
  status       text not null default 'new' check (status in ('new','assigned','hidden')),
  lead_id      uuid references public.listing_leads(id) on delete set null,
  item_id      uuid references public.listing_items(id) on delete set null,
  suggest_lead uuid references public.listing_leads(id) on delete set null,
  suggest_why  text not null default '',
  created_at   timestamptz not null default now(),
  unique (user_id, source, source_id)
);
create index if not exists listing_recordings_user on public.listing_recordings (user_id, status, recorded_at desc);
alter table public.listing_recordings enable row level security;
drop policy if exists listing_recordings_own on public.listing_recordings;
create policy listing_recordings_own on public.listing_recordings for select to authenticated
  using ((select auth.uid()) = user_id and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid())));
drop policy if exists listing_recordings_own_upd on public.listing_recordings;
create policy listing_recordings_own_upd on public.listing_recordings for update to authenticated
  using ((select auth.uid()) = user_id and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid())))
  with check ((select auth.uid()) = user_id);
revoke all on public.listing_recordings from anon;
grant select, update on public.listing_recordings to authenticated;
