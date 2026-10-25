-- Listing Assistant: quick capture (Oct 25, 2026). A Siri shortcut or an email sends a note into the same inbox as
-- the Granola recordings (listing_recordings, source 'shortcut' or 'email'). Each person has one private capture
-- token; only the listing-capture Edge Function (service role) reads this table. Safe to re-run.
create table if not exists public.listing_capture (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  token      text not null unique,
  created_at timestamptz not null default now()
);
alter table public.listing_capture enable row level security;
revoke all on public.listing_capture from anon, authenticated;
