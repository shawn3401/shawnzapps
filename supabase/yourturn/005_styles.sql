-- Your Turn: Claude's one-time sort of a place into fast food, fast casual, or sit-down, shared by everyone.
-- Holds only the Google place id and our own label, nothing from Google's listing. Written by the Edge
-- Function with the service role. A person's correction in a place's Details still wins. Safe to re-run.
create table if not exists public.yourturn_styles (
  place_id   text primary key,
  style      text not null check (style in ('fast_food','fast_casual','sit_down')),
  source     text not null default 'ai',
  created_at timestamptz not null default now()
);
alter table public.yourturn_styles enable row level security;   -- no policies: service role only
revoke all on public.yourturn_styles from anon, authenticated;

-- To have a place sorted again: delete from public.yourturn_styles where place_id = '...';
