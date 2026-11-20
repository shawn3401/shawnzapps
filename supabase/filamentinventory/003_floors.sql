-- Work by floor (Shawn, Nov 20, 2026): each floor has its own shelf order, and a count is checked off per floor.
-- Safe to re-run.

alter table filament_items add column if not exists main_pos int;
alter table filament_items add column if not exists up_pos int;
alter table filament_items add column if not exists checked_main_at timestamptz;
alter table filament_items add column if not exists checked_up_at timestamptz;

-- Starting shelf order for both floors: the old list order (PLA Basic, PLA Matte, PETG, then by sort).
with o as (
  select id, row_number() over (partition by user_id order by
    case material when 'PLA' then 0 when 'PETG' then 1 else 9 end, material,
    case when subtype = 'Basic' then 0 else 1 end, subtype, sort nulls last, color) as n
  from filament_items
)
update filament_items f set main_pos = coalesce(f.main_pos, o.n), up_pos = coalesce(f.up_pos, o.n)
from o where o.id = f.id and (f.main_pos is null or f.up_pos is null);

-- Save a whole floor's order in one call. Runs as the caller, so RLS limits it to their own rows.
create or replace function filament_set_order(p_ids uuid[], p_floor text)
returns void language sql security invoker set search_path = public as $$
  update filament_items f
     set main_pos = case when p_floor = 'main' then t.n::int else f.main_pos end,
         up_pos   = case when p_floor = 'up'   then t.n::int else f.up_pos end,
         updated_at = now()
    from unnest(p_ids) with ordinality as t(id, n)
   where f.id = t.id;
$$;
revoke execute on function filament_set_order(uuid[], text) from public, anon;
grant execute on function filament_set_order(uuid[], text) to authenticated;
