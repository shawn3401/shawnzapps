-- Listing Assistant: the agent's note on a file (Shawn, Oct 22, 2026). He uploaded a partial listing he is still
-- writing and did not want the AI to take it as fact; a note like "draft, check it against everything else" now
-- travels with the file, and every AI function is told to follow it. Safe to re-run.
alter table public.listing_items add column if not exists note text not null default '';
