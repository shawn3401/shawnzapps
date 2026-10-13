-- Your Turn: let anyone mark a saved place as not a restaurant (a gas station, a grocery deli),
-- which hides it from everyone's deals. Safe to re-run.
alter table public.yourturn_places add column if not exists not_food boolean not null default false;
