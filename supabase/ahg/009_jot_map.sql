-- Turning jots into Access-style leads and sales: the mapping rules only (no writes). Safe to re-run.
-- Used by the automatic step (010) and by the accuracy check against what the success team typed
-- into Access. Rules agreed with Shawn Oct 21, 2026 (see CLAUDE.md, "Opportunity jot").
set client_min_messages = warning;
create extension if not exists pg_trgm with schema extensions;

-- Opportunity Path lead source (question 16) and referral type (51) to Access lead_source ids.
create table if not exists public.jot_source_map (
  jot_value text primary key,
  lead_source integer not null
);
insert into public.jot_source_map values
  ('Brivity Paid Leads', 55), ('Circle Prospecting', 38), ('CINC', 24), ('Cold Calling', 5), ('Door Knocking', 52),
  ('Facebook- Free', 48), ('Facebook - Paid', 31), ('FSBO', 22), ('Google Reviews', 51), ('Google Search', 50),
  ('Ideal Agent', 47), ('KWKLY Sign', 54), ('Open House', 14), ('Other', 15), ('Past Client (Repeat)', 28),
  ('QR Code Signs', 53), ('Rate Radio', 32), ('Rate TV', 21), ('REAIT (Beck paid referral)', 29), ('Sign Call', 11),
  ('Sphere', 33), ('Trulia', 7), ('Vehicle Wraps', 49), ('Walk in/Floor time', 37), ('Zillow Premier', 56),
  ('Zillow Our Listing', 6), ('Zillow Reviews', 44),
  -- referral jots leave the source blank and give the referral type instead
  ('From Paid Referral Source (Agent, Referral Company)', 9), ('From Sphere', 1), ('From Past Client', 16), ('From Vendor', 36)
on conflict (jot_value) do update set lead_source = excluded.lead_source;
alter table public.jot_source_map enable row level security;
revoke all on public.jot_source_map from anon, authenticated;
grant select on public.jot_source_map to authenticated;
drop policy if exists "staff read" on public.jot_source_map;
create policy "staff read" on public.jot_source_map for select to authenticated using (public.is_staff());

-- Small readers for Jotform answers.
create or replace function public.jot_ts(v jsonb) returns timestamp language sql immutable as $$
  select nullif(v ->> 'datetime', '')::timestamp
$$;
-- The first number in a typed answer: "$1,175,000", "25%", "2.5 % of sale" (later numbers are ignored).
create or replace function public.jot_num(t text) returns numeric language sql immutable as $$
  select nullif(rtrim(replace(substring(coalesce(t, '') from '[0-9][0-9,]*\.?[0-9]*'), ',', ''), '.'), '')::numeric
$$;
-- "25%", "25", "2.5 %", ".03" -> a fraction (0.25, 0.025, 0.03)
create or replace function public.jot_pct(t text) returns numeric language sql immutable as $$
  select case when public.jot_num(t) is null then null when public.jot_num(t) > 1 then public.jot_num(t) / 100 else public.jot_num(t) end
$$;
create or replace function public.norm_name(t text) returns text language sql immutable as $$
  select lower(regexp_replace(coalesce(t, ''), '[^A-Za-z]', '', 'g'))
$$;

-- A person named in a jot -> the Access team member. Dropdown first names go through jot_people;
-- typed names match a full name ignoring spaces ("Mike J Johnston" = "MikeJ Johnston"), then a unique
-- current team member with that first name, then "Michael ... Johnston" style first initial + last name.
create or replace function public.jot_person(t text) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select team_member_id from jot_people where jot_name = trim(t)),
    (select min(id) from team_members where norm_name(team_member_name) = norm_name(t) having count(*) = 1),
    (select min(id) from team_members where active = 'Yes' and lower(split_part(team_member_name, ' ', 1)) = lower(split_part(trim(t), ' ', 1)) having count(*) = 1),
    (select min(id) from team_members where active = 'Yes'
       and lower(split_part(team_member_name, ' ', array_length(string_to_array(team_member_name, ' '), 1))) = lower(split_part(trim(t), ' ', array_length(string_to_array(trim(t), ' '), 1)))
       and lower(left(team_member_name, 1)) = lower(left(trim(t), 1)) having count(*) = 1))
$$;

-- Tidy a typed name the way the success team writes it: no "quoted" nicknames, single spaces, and
-- ALL CAPS or all lower case turned into Normal Case.
create or replace function public.jot_tidy(t text) returns text language sql immutable as $$
  select case when x = upper(x) or x = lower(x) then initcap(x) else x end
  from (select trim(regexp_replace(regexp_replace(coalesce(t, ''), '\s*["“”][^"“”]*["“”]', '', 'g'), '\s+', ' ', 'g')) x) y
$$;

-- Agents sometimes type the wrong year in "Date Lead Received" (2025 for 2026). If the date is more
-- than 45 days from when the jot was submitted and the same month and day in the submitted year is
-- within 45 days, use that. jot_lead_values() keeps the original in 'received_as_typed' so it can be flagged.
create or replace function public.jot_fix_year(d date, submitted date) returns date language sql immutable as $$
  select case when d is null or submitted is null or abs(d - submitted) <= 45 then d
              when abs(make_date(extract(year from submitted)::int, extract(month from d)::int, least(extract(day from d)::int, 28)) - submitted) <= 45
                then make_date(extract(year from submitted)::int, extract(month from d)::int, extract(day from d)::int)
              else d end
$$;

-- "Eli" + "Jaya Christensen" style: two clients sharing a last name become "Eli & Jaya Christensen",
-- otherwise "Name One & Name Two", as Access lead names are written.
drop function if exists public.jot_client_name(text, text) cascade;
create or replace function public.jot_client_name(a0 text, b0 text) returns text language sql immutable as $$
  select case
    when nullif(trim(b), '') is null then trim(a)
    when nullif(trim(a), '') is null then trim(b)
    when lower(split_part(trim(a), ' ', array_length(string_to_array(trim(a), ' '), 1))) = lower(split_part(trim(b), ' ', array_length(string_to_array(trim(b), ' '), 1)))
      and array_length(string_to_array(trim(a), ' '), 1) > 1
      then array_to_string((string_to_array(trim(a), ' '))[1:array_length(string_to_array(trim(a), ' '), 1) - 1], ' ') || ' & ' || trim(b)
    else trim(a) || ' & ' || trim(b) end
  from (select public.jot_tidy(a0) a, public.jot_tidy(b0) b) n
$$;

-- One Opportunity Path jot -> the lead fields it sets, for one side ('Buyer' or 'Seller'; a
-- "Buyer and Seller" jot makes one of each). Only fields the jot actually answers are included.
-- Second and third consultation are never set: they are only for a client regained 6+ months later.
drop function if exists public.jot_lead_values(jsonb, text);
create or replace function public.jot_lead_values(a jsonb, side text, submitted date) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'lead_name', jot_client_name(a ->> '36', a ->> '37'),
    'lead_type', side,
    'sales_rep', (select team_member_id from jot_people where jot_name = a ->> '70'),
    'lead_received_date', jot_fix_year(jot_ts(a -> '73')::date, submitted),
    'received_as_typed', case when jot_fix_year(jot_ts(a -> '73')::date, submitted) <> jot_ts(a -> '73')::date then jot_ts(a -> '73')::date end,
    'lead_source', (select lead_source from jot_source_map where jot_value = coalesce(case when a ->> '197' = 'Yes' then a ->> '51' end, a ->> '16')),
    'lead_source_detail', coalesce(nullif(trim(a ->> '52'), ''), case when a ->> '197' = 'Yes' then nullif(trim(a ->> '27'), '') end),
    -- "me", or the submitter's own first name, means the person who filled in the jot
    'team_member_credit', case when a ->> '204' = 'Anderson Hicks Group' then 'Anderson Hicks'
                               when a ? '24' then coalesce(
                                 (select team_member_name from team_members where id = (select team_member_id from jot_people where jot_name = a ->> '82')
                                    and (lower(trim(a ->> '24')) in ('me', 'myself', 'self') or lower(split_part(a ->> '82', ' ', 1)) = lower(trim(a ->> '24')))),
                                 (select team_member_name from team_members where id = jot_person(a ->> '24')), trim(a ->> '24')) end,
    'trigger', case a ->> '205' when 'None' then 'None' when 'Event' then 'Client Events' when 'Promise' then 'Promise Script' when 'Vyral Email Blast' then 'Vyral Marketing' end,
    'first_appt_set_on_date', jot_ts(a -> '75')::date,
    -- a reschedule moves the first consultation to the new time
    'first_appt_set_for_date', case when a ->> '200' = 'No - Rescheduled' and a ? '113' then jot_ts(a -> '113') else jot_ts(a -> '76') end,
    'first_appt_set_by', (select t.team_member_name from jot_people p join team_members t on t.id = p.team_member_id where p.jot_name = a ->> '41'),
    'first_appt_date', case when a ->> '200' = 'Yes' then jot_ts(a -> '182')::date end,
    -- the recap is the handoff: held, or cancelled (a no-show); not for a reschedule or "not yet"
    'first_appt_handoff_date', case when a ->> '200' in ('Yes', 'No - Cancelled') then jot_ts(a -> '180') end,
    'agent_gave_promise_lead', a ->> '236',
    'representation_contract_signed_date', case side when 'Seller' then jot_ts(a -> '115')::date else jot_ts(a -> '114')::date end,
    -- Left out on purpose: the team doesn't fill these in Access (price estimate is always 0, primary
    -- city and rep expiration are almost always blank), so the jot doesn't either.
    'lead_note', nullif(concat_ws(E'\n',
      'From the Opportunity Path jot.',
      nullif(concat_ws(', ', nullif(trim(a ->> '191'), ''), nullif(trim(a ->> '11'), '')), ''),
      nullif(concat_ws(', ', nullif(trim(a ->> '192'), ''), nullif(trim(a ->> '15'), '')), ''),
      nullif(concat_ws(', ', nullif(trim(a ->> '12'), ''), nullif(trim(a ->> '44'), '')), '')), 'From the Opportunity Path jot.')
  ))
$$;
grant execute on function public.jot_lead_values(jsonb, text, date) to authenticated;

notify pgrst, 'reload schema';

-- Split a typed address ("1000 Red Robin Ave, Idaho Falls, 83401") into street and a city from the
-- Access city list. If no listed city is in it, the whole thing is the street and city stays empty.
create or replace function public.jot_address(t text) returns jsonb
language sql stable security definer set search_path = public as $$
  with c as (select city_name, position(lower(city_name) in lower(t)) p from city_list
             where position(lower(city_name) in lower(t)) > 1 order by length(city_name) desc limit 1)
  select case when (select p from c) is null then jsonb_build_object('address', nullif(trim(t), ''))
    else jsonb_build_object('address', trim(both ' ,*-' from left(t, (select p from c) - 1)), 'city', (select city_name from c)) end
$$;

-- One Contract Cover Sheet jot -> the sale fields it sets. The lead (Client) is matched separately.
-- Shawn's rules (Oct 21, 2026): a paid referral is paid by Brokerage; no final commission in the jot
-- means 3%. Close dates and title company aren't in the jot; the success team adds them. The lender
-- becomes a Lenders tab row (jot_create_sale). "Commissions paid on concessions" is left to the table
-- default for now: Access usually has it checked even when the jot says No (asked Shawn Oct 21, 2026).
create or replace function public.jot_sale_values(a jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_strip_nulls(jot_address(a ->> '9') || jsonb_build_object(
    'sale_type', case a ->> '48' when 'Buyer' then 'Sale' when 'Seller' then 'Listing' end,
    'primary_sales_rep', jot_person(a ->> '4'),
    'coop_agent', nullif(jot_tidy(a ->> '6'), ''),
    'purchase_price', jot_num(a ->> '58'),
    'contract_date', jot_ts(a -> '76')::date,
    'outside_agent_referral_percent', case when a ->> '18' = 'Yes' then coalesce(jot_pct(a ->> '19'), 0) else 0 end,
    'referral_paidby', case when a ->> '18' = 'Yes' then 'Brokerage' else 'NA' end,
    'projected_commission_percent', coalesce(jot_pct(case a ->> '48' when 'Seller' then a ->> '21' else a ->> '22' end), 0.03),
    'transaction_fees_bonuses', case when a ->> '23' = 'No' then 0 else coalesce(jot_num(a ->> '24'), 0) end,
    'agent_gave_promise_sale', a ->> '10',
    'termination_date', case when a ->> '36' = 'Yes' then jot_ts(a -> '60')::date end,
    'termination_reason', case when a ->> '36' = 'Yes' then a ->> '37' end,
    'termination_did_buyer_see', case when a ->> '36' = 'Yes' and a ? '39' then a ->> '39' = 'Yes' end,
    'termination_inspection_detail', case when a ->> '36' = 'Yes' and a ? '40' then a ->> '40' = 'Yes' end,
    'termination_financing_detail', case when a ->> '36' = 'Yes' and a ? '41' then a ->> '41' = 'Yes' end
  ))
$$;
grant execute on function public.jot_sale_values(jsonb) to authenticated;
notify pgrst, 'reload schema';
