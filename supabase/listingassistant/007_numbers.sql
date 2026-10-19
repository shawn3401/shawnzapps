-- Listing Assistant: the Value card (Shawn, Oct 19, 2026), the numbers that bear on value, kept as they come in.
-- numbers = { tax | zest | wants | loan | cma_low | cma_high: {amount, note, at, history: [{amount, note, at}]},
--             hints: { <key>: {amount, evidence, at, item_id} } }
-- All entry is by hand or through Ask; Zillow blocks automated lookups, so nothing is fetched. A hint is a number
-- the listing-todos function spotted in a note or transcript; the agent taps Use it or Dismiss. Safe to re-run.
alter table public.listing_leads add column if not exists numbers jsonb not null default '{}';
