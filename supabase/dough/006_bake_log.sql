-- Dough app: timestamped updates on a bake while it is in progress ("8:00 am, out of the fridge for the final rise").
-- [{at: ISO timestamp, text}], oldest first. Safe to re-run.
alter table public.dough_bakes add column if not exists log jsonb not null default '[]'::jsonb;
