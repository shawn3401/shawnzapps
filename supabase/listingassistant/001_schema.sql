-- Listing Assistant: seller leads, the material gathered on each one (calls, walkthroughs, notes, photos),
-- and the AI brief built from it. ShawnZapps project, tables prefixed listing_. Safe to re-run.
-- Client and property details live here, so everything is allow-list only (listing_access) and private.

-- Who may use the app at all. Signups are open on this project, so no row here means no access.
create table if not exists public.listing_access (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  daily_limit int not null default 60 check (daily_limit >= 0),   -- AI and transcription calls per 24 hours
  created_at  timestamptz not null default now()
);
alter table public.listing_access enable row level security;
drop policy if exists listing_access_select on public.listing_access;
create policy listing_access_select on public.listing_access for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.listing_access from anon, authenticated;
grant select on public.listing_access to authenticated;

create table if not exists public.listing_leads (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name       text not null default '',
  address    text not null default '',
  phone      text not null default '',
  email      text not null default '',
  stage      text not null default 'new' check (stage in ('new','call','walk_set','walked','pricing','signed','listed','hold','closed')),
  next_step  text not null default '',
  brief      jsonb,                          -- the AI's last output, as returned by the listing-ai function
  brief_at   timestamptz,
  form       jsonb not null default '{}'     -- the On Site Property Info Form as it stands: AI draft plus the agent's edits
);
create index if not exists listing_leads_user on public.listing_leads (user_id, updated_at desc);

create table if not exists public.listing_items (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.listing_leads(id) on delete cascade,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  kind        text not null default 'note' check (kind in ('call','walkthrough','note','photos')),
  occurred_on date not null default ((now() at time zone 'America/Boise')::date),
  title       text not null default '',
  transcript  text not null default '',      -- pasted or transcribed words, or a typed note
  files       jsonb not null default '[]',   -- [{path, name, type, size}] in the listing-files bucket
  status      text not null default 'ready' check (status in ('ready','transcribing','failed')),
  error       text not null default ''
);
create index if not exists listing_items_lead on public.listing_items (lead_id, occurred_on, created_at);

alter table public.listing_leads enable row level security;
alter table public.listing_items enable row level security;
drop policy if exists listing_leads_own on public.listing_leads;
create policy listing_leads_own on public.listing_leads for all to authenticated
  using ((select auth.uid()) = user_id and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid())))
  with check ((select auth.uid()) = user_id and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid())));
drop policy if exists listing_items_own on public.listing_items;
create policy listing_items_own on public.listing_items for all to authenticated
  using ((select auth.uid()) = user_id and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid())))
  with check ((select auth.uid()) = user_id and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid()))
              and exists (select 1 from public.listing_leads l where l.id = lead_id and l.user_id = (select auth.uid())));
revoke all on public.listing_leads, public.listing_items from anon;
grant select, insert, update, delete on public.listing_leads, public.listing_items to authenticated;

create or replace function public.listing_touch() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists listing_leads_touch on public.listing_leads;
create trigger listing_leads_touch before update on public.listing_leads for each row execute function public.listing_touch();

-- One row per AI or transcription call, for the daily cap and cost tracking. Service role only.
create table if not exists public.listing_usage (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  kind          text not null default 'brief',
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  seconds       numeric not null default 0
);
create index if not exists listing_usage_user_time on public.listing_usage (user_id, created_at desc);
alter table public.listing_usage enable row level security;
revoke all on public.listing_usage from anon, authenticated;

-- Private files: recordings, photos, documents at <user id>/<lead id>/<uuid>.<ext>, and the team's blank
-- form at _shared/form-blank.pdf. Nothing here is public; the page reads through signed links.
insert into storage.buckets (id, name, public, file_size_limit)
values ('listing-files', 'listing-files', false, 209715200)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists listing_files_own on storage.objects;
create policy listing_files_own on storage.objects for all to authenticated
  using (bucket_id = 'listing-files' and (storage.foldername(name))[1] = (select auth.uid())::text
         and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid())))
  with check (bucket_id = 'listing-files' and (storage.foldername(name))[1] = (select auth.uid())::text
         and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid())));
drop policy if exists listing_files_shared on storage.objects;
create policy listing_files_shared on storage.objects for all to authenticated
  using (bucket_id = 'listing-files' and (storage.foldername(name))[1] = '_shared'
         and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid())))
  with check (bucket_id = 'listing-files' and (storage.foldername(name))[1] = '_shared'
         and exists (select 1 from public.listing_access a where a.user_id = (select auth.uid())));

-- To let someone in:
--   insert into public.listing_access (user_id) select id from auth.users where email = 'agent@example.com';
