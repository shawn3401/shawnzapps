-- Listing Assistant: a cover photo per lead (Shawn, Oct 21, 2026). The storage path of one of the lead's own photos
-- in listing-files; it shows as a banner on the lead and a thumbnail on the leads list. Safe to re-run.
alter table public.listing_leads add column if not exists cover text;
