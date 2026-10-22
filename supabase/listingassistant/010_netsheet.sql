-- Listing Assistant: the Net sheet (Shawn, Oct 22, 2026). The lead's net sheets live in listing_leads.netsheet
-- (mode, shared inputs, appt prices, listing price, offers[] with each offer's terms and per-line overrides).
-- listing_settings holds team-wide values; key "fees" has the fee defaults every net sheet starts from.
-- Readable and writable by anyone on the allow-list. Safe to re-run.
alter table public.listing_leads add column if not exists netsheet jsonb not null default '{}';
create table if not exists public.listing_settings (
  key        text primary key,
  value      jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.listing_settings enable row level security;
drop policy if exists listing_settings_team on public.listing_settings;
create policy listing_settings_team on public.listing_settings for all to authenticated
  using (exists (select 1 from public.listing_access a where a.user_id = (select auth.uid())))
  with check (exists (select 1 from public.listing_access a where a.user_id = (select auth.uid())));
revoke all on public.listing_settings from anon;
grant select, insert, update on public.listing_settings to authenticated;
