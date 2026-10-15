-- Listing Assistant: a note written on a to-do (Shawn, Oct 14, 2026: "notes on these I want to drop in as I
-- complete them"). It is an ordinary note entry, so the brief and the form read it like any other, with
-- title "To-do: <text>" and todo_id pointing at the to-do it belongs to. Safe to re-run.
alter table public.listing_items add column if not exists todo_id uuid references public.listing_todos(id) on delete set null;
create index if not exists listing_items_todo on public.listing_items (todo_id) where todo_id is not null;
