-- Report distribution (Shawn, Oct 21, 2026): who gets which report emails, how often, and when.
-- Edge Function send-reports builds each email from the same database functions the pages use and
-- sends it from reports@andersonhicks.com through the Gmail API (Google Workspace service account
-- with domain-wide delegation, secret GOOGLE_SERVICE_ACCOUNT). pg_cron calls it every 15 minutes
-- and it sends every distribution that is due. Managed on the "Report distribution" page (admins).
-- Safe to re-run.
set client_min_messages = warning;
drop table if exists public.report_schedules;   -- the first, one-row-per-report version (same day)

create table if not exists public.report_distributions (
  id bigint generated always as identity primary key,
  report text not null check (report in ('dlr', 'hustle', 'tracker')),
  name text not null,                          -- e.g. "Leadership team", "All agents"
  recipients text[] not null default '{}',
  frequency text not null default 'weekdays' check (frequency in ('weekdays', 'daily', 'days', 'monthly')),
  days int[] not null default '{}',            -- 'days': ISO weekdays, 1 = Monday
  month_day int check (month_day between 1 and 31),   -- 'monthly' (31 = last day of the month)
  send_time time not null default '07:00',     -- Mountain time
  mode text not null default 'test' check (mode in ('test', 'live')),   -- test sends only to the person who made it
  test_to text not null default lower(auth.jwt() ->> 'email'),
  active boolean not null default true,
  last_sent_on date,
  created_by text default lower(auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);

create table if not exists public.report_sends (
  id bigint generated always as identity primary key,
  distribution_id bigint,
  report text not null,
  sent_at timestamptz not null default now(),
  mode text not null,                          -- test, live, manual
  recipients text[] not null,
  ok boolean not null,
  detail text
);
alter table public.report_sends add column if not exists distribution_id bigint;

do $$
declare t text;
begin
  foreach t in array array['report_distributions', 'report_sends'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists "admins read" on public.%I', t);
    execute format('create policy "admins read" on public.%I for select to authenticated using ((select public.is_admin()))', t);
  end loop;
end $$;
grant insert, update, delete on public.report_distributions to authenticated;
drop policy if exists "admins add" on public.report_distributions;
drop policy if exists "admins change" on public.report_distributions;
drop policy if exists "admins remove" on public.report_distributions;
create policy "admins add" on public.report_distributions for insert to authenticated with check ((select public.is_admin()));
create policy "admins change" on public.report_distributions for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admins remove" on public.report_distributions for delete to authenticated using ((select public.is_admin()));

-- Starting point, both in test mode (only Shawn gets them) until he switches them to live.
insert into public.report_distributions (report, name, recipients, frequency, send_time, mode, test_to, created_by)
select * from (values
  ('dlr', 'Leadership team', '{execs@andersonhicks.com,trevor@andersonhicks.com,aaron@andersonhicks.com}'::text[], 'weekdays', '07:00'::time, 'test', 'shawn@andersonhicks.com', 'shawn@andersonhicks.com'),
  ('hustle', 'All agents', '{}'::text[], 'weekdays', '07:00'::time, 'test', 'shawn@andersonhicks.com', 'shawn@andersonhicks.com')) v
where not exists (select 1 from public.report_distributions);

-- The send function runs as the service role, which has no team-list email; let it read the board.
create or replace function public.can_read_reports() returns boolean language sql stable security definer set search_path = public as $$
  select public.my_role() is not null or coalesce(auth.role(), '') = 'service_role'
$$;

-- Every 15 minutes: send whatever is due (the function decides; it skips anything sent today).
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('send-reports') where exists (select 1 from cron.job where jobname = 'send-reports');
select cron.schedule('send-reports', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://pjfiyfljkzcvfvcrdrcj.supabase.co/functions/v1/send-reports',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBqZml5Zmxqa3pjdmZ2Y3JkcmNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1MjI3MzYsImV4cCI6MjEwODA5ODczNn0.h-hjuhJc_QeqebwYvQSjBywE2ZcR4bOjY85deroEW8c'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000)
$$);
notify pgrst, 'reload schema';
