-- Listing Assistant: every to-do belongs to one of three (Shawn, Oct 13, 2026): the Listing Agent ('agent'),
-- the Seller ('seller'), or the Success Team ('team'). Before this, `who` was free text ("Me" or a name).
-- Safe to re-run.
update public.listing_todos set who = case when who in ('agent','seller','team') then who when who = '' or lower(who) in ('me','agent','listing agent') then 'agent' when lower(who) like '%team%' or lower(who) like '%admin%' or lower(who) like '%office%' then 'team' else 'seller' end;
alter table public.listing_todos alter column who set default 'agent';
alter table public.listing_todos drop constraint if exists listing_todos_who_check;
alter table public.listing_todos add constraint listing_todos_who_check check (who in ('agent','seller','team'));
