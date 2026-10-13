-- Dough app: who may use the AI helper, and a log of each call for the daily cap and cost tracking.
-- The Edge Function `dough-ai` reads and writes these with the service role. Safe to re-run.

create table if not exists public.dough_ai_access (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  daily_limit int not null default 40 check (daily_limit >= 0),
  created_at  timestamptz not null default now()
);
alter table public.dough_ai_access enable row level security;
-- A person can see whether they have access (the page uses this to show the button). Only the dashboard grants it.
drop policy if exists dough_ai_access_select on public.dough_ai_access;
create policy dough_ai_access_select on public.dough_ai_access for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.dough_ai_access from anon, authenticated;
grant select on public.dough_ai_access to authenticated;

create table if not exists public.dough_ai_usage (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  input_tokens  int not null default 0,
  output_tokens int not null default 0,
  searches      int not null default 0
);
create index if not exists dough_ai_usage_user_time on public.dough_ai_usage (user_id, created_at desc);
alter table public.dough_ai_usage enable row level security;   -- no policies: service role only
revoke all on public.dough_ai_usage from anon, authenticated;

-- To give someone the AI helper:
--   insert into public.dough_ai_access (user_id) select id from auth.users where email = 'friend@example.com';
