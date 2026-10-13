-- Dough app: categories (fixed list in the page: pizza, bread, rolls, cinnamon_rolls) with the person's recipes inside.
-- A row in dough_types is a recipe. Safe to re-run.

alter table public.dough_types add column if not exists category text;
update public.dough_types set category = case
    when name ilike '%cinnamon%' then 'cinnamon_rolls'
    when name ilike '%pizza%' or sizing = 'pizza' then 'pizza'
    when name ilike '%roll%' or name ilike '%bun%' then 'rolls'
    else 'bread' end
  where category is null;
alter table public.dough_types alter column category set default 'bread';
alter table public.dough_types alter column category set not null;

alter table public.dough_bakes add column if not exists category text;
update public.dough_bakes b set category = coalesce(
    (select t.category from public.dough_types t where t.id = b.type_id),
    case when b.type_name ilike '%cinnamon%' then 'cinnamon_rolls'
         when b.type_name ilike '%pizza%' or b.sizing = 'pizza' then 'pizza'
         when b.type_name ilike '%roll%' or b.type_name ilike '%bun%' then 'rolls'
         else 'bread' end)
  where category is null;
