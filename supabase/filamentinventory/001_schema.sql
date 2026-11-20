-- Filament: spool counts and the reorder list. Safe to re-run.
-- One row per filament per person. Counts are whole spools on two shelves:
-- main (the active spool on the main floor) and upstairs (backups).

create table if not exists filament_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  code text,                      -- Bambu's filament code, like 10100
  material text not null,         -- PLA, PETG
  subtype text,                   -- Basic, Matte
  color text not null,            -- Jade White
  hex text,                       -- swatch color shown in the app (an approximation)
  sort int,                       -- order within its material and subtype
  speed text not null default 'normal' check (speed in ('normal','heavy','slow')),
  main int not null default 0 check (main >= 0),
  upstairs int not null default 0 check (upstairs >= 0),
  level text check (level in ('over_half','half','empty')),   -- active spool, asked only for slow ones
  on_order int not null default 0 check (on_order >= 0),       -- ordered, not here yet
  checked_at timestamptz,         -- last time it was confirmed in a count
  retired boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A count: started, then finished. An item is "checked" in a count if checked_at >= started_at.
create table if not exists filament_counts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- What happened to each filament, for usage history later (how fast a color goes).
-- kind: count, swap (finished one, brought a backup down), ordered, received, edit
create table if not exists filament_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  item_id uuid not null references filament_items on delete cascade,
  at timestamptz not null default now(),
  kind text not null,
  main int,
  upstairs int,
  qty int
);

create index if not exists filament_items_user on filament_items (user_id);
create index if not exists filament_counts_user on filament_counts (user_id, started_at desc);
create index if not exists filament_log_item on filament_log (item_id, at desc);
create index if not exists filament_log_user on filament_log (user_id);

alter table filament_items enable row level security;
alter table filament_counts enable row level security;
alter table filament_log enable row level security;

drop policy if exists "own items" on filament_items;
create policy "own items" on filament_items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own counts" on filament_counts;
create policy "own counts" on filament_counts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own log" on filament_log;
create policy "own log" on filament_log for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

grant select, insert, update, delete on filament_items, filament_counts, filament_log to authenticated;
