-- What the Leads form needs. Safe to re-run; survives a data refresh.
set client_min_messages = warning;

-- Defaults from the Access Leads table.
alter table public.leads
  alter column lead_received_date set default (current_date),
  alter column date_time_entered set default (now() at time zone 'America/Denver'),
  alter column price_estimate set default 0,
  alter column competing_y_n set default false,
  alter column appt_qualification set default 'Qualified';

-- Appointment status per consultation, Access query Leads-Search (FirstApptStatus etc.).
create or replace function public.appt_status(qual text, set_for timestamp, appt timestamp, handoff timestamp)
returns text language sql immutable as $$
  select case
    when qual = 'Disqualified' then 'Disqualified'
    when set_for >= current_date then 'Scheduled'
    when set_for < current_date and handoff is null then 'Missing Interview'
    when set_for < current_date and appt is not null and handoff is not null then 'Appt Held'
    when set_for < current_date and appt is null and handoff is not null then 'No Show'
    else 'Not Scheduled' end
$$;

-- The Leads search, as in Access query Leads-Search: any part of the name, the note, or the
-- lead id. The most recent consultation is the third, else the second, else the first.
drop view if exists public.leads_search;
create view public.leads_search with (security_invoker = true) as
select l.id, l.lead_name, l.lead_type, ls.lead_source as source, l.sales_rep,
  tm.team_member_name as owner, l.team_member_credit, l.lead_received_date, l.date_time_entered,
  coalesce(l.third_appt_set_for_date, l.second_appt_set_for_date, l.first_appt_set_for_date) as appt_for,
  case when l.third_appt_set_on_date is not null then appt_status(l.appt_qualification, l.third_appt_set_for_date, l.third_appt_date, l.third_appt_handoff_date)
       when l.second_appt_set_on_date is not null then appt_status(l.appt_qualification, l.second_appt_set_for_date, l.second_appt_date, l.second_appt_handoff_date)
       else appt_status(l.appt_qualification, l.first_appt_set_for_date, l.first_appt_date, l.first_appt_handoff_date) end as appt_status,
  l.representation_contract_signed_date as rep_signed,
  concat_ws(' ', l.lead_name, l.lead_note, l.id::text) as search
from public.leads l
left join public.lead_source ls on ls.id = l.lead_source
left join public.team_members tm on tm.id = l.sales_rep;
revoke all on public.leads_search from anon;
grant select on public.leads_search to authenticated;

notify pgrst, 'reload schema';
