-- Your Turn: a per-person override of the daily Google search cap (the Edge Function's default is 40 calls,
-- and a search is 2). Service role only. Safe to re-run.
create table if not exists public.yourturn_limits (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  daily_limit int not null check (daily_limit >= 0),
  created_at  timestamptz not null default now()
);
alter table public.yourturn_limits enable row level security;   -- no policies: service role only
revoke all on public.yourturn_limits from anon, authenticated;

-- To raise someone's cap:
--   insert into public.yourturn_limits (user_id, daily_limit) select id, 200 from auth.users where email = 'friend@example.com'
--   on conflict (user_id) do update set daily_limit = excluded.daily_limit;
