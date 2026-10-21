-- Run Edge Function jot-sync every 5 minutes. Safe to re-run.
-- Uses the project's public (anon) key, which is already in every AHG Tools page; jot-sync skips
-- a run that comes under a minute after the last, so outside calls can't run up Jotform usage.
set client_min_messages = warning;
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('jot-sync') where exists (select 1 from cron.job where jobname = 'jot-sync');
select cron.schedule('jot-sync', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://pjfiyfljkzcvfvcrdrcj.supabase.co/functions/v1/jot-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBqZml5Zmxqa3pjdmZ2Y3JkcmNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1MjI3MzYsImV4cCI6MjEwODA5ODczNn0.h-hjuhJc_QeqebwYvQSjBywE2ZcR4bOjY85deroEW8c'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000)
$$);
