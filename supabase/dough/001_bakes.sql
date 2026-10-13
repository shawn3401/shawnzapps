-- Dough app, shawnzapps.com/dough/
-- Lives in the shared "ShawnZapps" Supabase project (hobby apps that need logins).
-- Every table for this app is prefixed dough_ so it can be lifted out later.
-- Safe to re-run.

create table if not exists public.dough_bakes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),

  -- the plan, locked in
  dough_type   text not null default 'pizza',
  made_on      date not null default current_date,
  bake_on      date,
  count        int  not null check (count between 1 and 50),
  size_in      numeric not null check (size_in between 4 and 30),
  thickness    numeric not null check (thickness > 0),        -- grams of dough per square inch
  ball_g       numeric not null check (ball_g > 0),
  flour_g      numeric not null check (flour_g > 0),
  pct          jsonb not null,                                  -- {water, yeast, salt, sugar, oil} as % of flour
  yeast_type   text not null default 'active_dry' check (yeast_type in ('active_dry','instant','fresh')),
  ferment      text not null default 'cold_long'  check (ferment in ('quick','same_day','cold_1','cold_long')),
  flour_name   text not null default '',
  plan_notes   text not null default '',

  -- the report, filled in after the bake
  rating       int check (rating between 1 and 5),
  went_well    text not null default '',
  went_poorly  text not null default '',
  next_time    text not null default '',
  reported_at  timestamptz
);

create index if not exists dough_bakes_user_made on public.dough_bakes (user_id, made_on desc, created_at desc);

alter table public.dough_bakes enable row level security;

-- Each person sees and changes only their own bakes.
drop policy if exists dough_bakes_select on public.dough_bakes;
drop policy if exists dough_bakes_insert on public.dough_bakes;
drop policy if exists dough_bakes_update on public.dough_bakes;
drop policy if exists dough_bakes_delete on public.dough_bakes;
create policy dough_bakes_select on public.dough_bakes for select to authenticated using ((select auth.uid()) = user_id);
create policy dough_bakes_insert on public.dough_bakes for insert to authenticated with check ((select auth.uid()) = user_id);
create policy dough_bakes_update on public.dough_bakes for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy dough_bakes_delete on public.dough_bakes for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.dough_bakes from anon;
grant select, insert, update, delete on public.dough_bakes to authenticated;
