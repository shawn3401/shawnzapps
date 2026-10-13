-- Dough app: user-managed dough types (pizza, bread, ...) and user-owned steps.
-- Safe to re-run.

create table if not exists public.dough_types (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  name        text not null check (char_length(name) between 1 and 40),
  sizing      text not null default 'pieces' check (sizing in ('pizza','pieces','flour')),
  ingredients jsonb not null default '[]'::jsonb,   -- [{key, name, pct}], flour is always 100 and not listed
  steps       text,                                  -- one step per line; null = none written yet
  defaults    jsonb not null default '{}'::jsonb     -- the plan from the last locked-in bake
);
create index if not exists dough_types_user on public.dough_types (user_id, created_at);
alter table public.dough_types enable row level security;
drop policy if exists dough_types_select on public.dough_types;
drop policy if exists dough_types_insert on public.dough_types;
drop policy if exists dough_types_update on public.dough_types;
drop policy if exists dough_types_delete on public.dough_types;
create policy dough_types_select on public.dough_types for select to authenticated using ((select auth.uid()) = user_id);
create policy dough_types_insert on public.dough_types for insert to authenticated with check ((select auth.uid()) = user_id);
create policy dough_types_update on public.dough_types for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy dough_types_delete on public.dough_types for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.dough_types from anon;
grant select, insert, update, delete on public.dough_types to authenticated;

-- A bake is a snapshot: it keeps the type's name, ingredient list, and steps as they were that day.
alter table public.dough_bakes
  add column if not exists type_id     uuid references public.dough_types(id) on delete set null,
  add column if not exists type_name   text not null default 'Pizza',
  add column if not exists sizing      text not null default 'pizza' check (sizing in ('pizza','pieces','flour')),
  add column if not exists ingredients jsonb,
  add column if not exists steps       text not null default '';
alter table public.dough_bakes alter column size_in drop not null;
alter table public.dough_bakes alter column thickness drop not null;
alter table public.dough_bakes alter column pct drop not null;
create index if not exists dough_bakes_type on public.dough_bakes (type_id);

-- Bakes from before this change stored {water, yeast, salt, sugar, oil} in pct.
update public.dough_bakes set ingredients = (
  select jsonb_agg(jsonb_build_object('key', k.key, 'name', k.name, 'pct', (pct ->> k.key)::numeric) order by k.ord)
  from (values ('water','Water',1),('yeast','Yeast',2),('salt','Salt',3),('sugar','Sugar',4),('oil','Olive oil',5)) as k(key, name, ord)
  where pct ? k.key
) where ingredients is null and pct is not null;

-- Oct 4, 2026: each timing ("How long until you bake?") keeps its own steps and yeast amount.
-- {ferment_key: {steps, yeast, yeast_type}}; dough_types.steps stays as the last-used set.
alter table public.dough_types add column if not exists variants jsonb not null default '{}'::jsonb;
