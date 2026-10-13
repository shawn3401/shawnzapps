-- Dough app: making the next batch better. Safe to re-run.
--   changes: what was different from the bake before, as short lines ("Water 62% to 64%"), saved at lock-in
--   suggest: the AI's suggested changes after the report, kept so they are paid for once
--            {summary, changes:[{ingredient, to_pct, why}], tips:[{title, detail}]}
--   kept:    the person's answer at report time to "keep this bake's ratios in the recipe?"
--            Lock-in no longer writes ratios to the recipe; a change has to earn its place.
alter table public.dough_bakes
  add column if not exists changes jsonb not null default '[]'::jsonb,
  add column if not exists suggest jsonb,
  add column if not exists kept    boolean;
