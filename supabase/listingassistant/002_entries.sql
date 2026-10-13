-- Listing Assistant: one kind of entry on a lead (Shawn, Oct 13, 2026). An entry is either a note
-- (typed or pasted words in `transcript`, no files) or a file (one upload in `files`, with `title` = its
-- name and `transcript` = the words of a recording once transcribed). The call / walkthrough / photos
-- labels are gone. No rows existed when this ran. Safe to re-run.
alter table public.listing_items drop constraint if exists listing_items_kind_check;
alter table public.listing_items add constraint listing_items_kind_check check (kind in ('note','file'));
