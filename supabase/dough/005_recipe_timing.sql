-- Dough app: a recipe is written for ONE timing (dough_types.timing, a FERMENT key in the page).
-- Picking a different timing for a bake shows AI suggestions, cached in dough_types.tips
-- as {ferment_key: {sig, tips:[{title, detail}], yeast_pct, note}}. The recipe itself is not changed.
-- dough_types.variants (per-timing step versions, Oct 4 2026 morning) is no longer read. Safe to re-run.

alter table public.dough_types add column if not exists timing text;
alter table public.dough_types add column if not exists tips jsonb not null default '{}'::jsonb;
update public.dough_types set timing = coalesce(
    case when defaults->>'ferment' in ('quick','same_day','cold_1','cold_long') then defaults->>'ferment' end,
    case when name ilike '%overnight%' or name ilike '%next morning%' then 'cold_1'
         when sizing = 'pizza' then 'cold_long' else 'same_day' end)
  where timing is null;
alter table public.dough_types alter column timing set default 'same_day';
alter table public.dough_types alter column timing set not null;

-- Notes about the recipe itself (where it came from, what to remember), not about one bake.
alter table public.dough_types add column if not exists notes text not null default '';
