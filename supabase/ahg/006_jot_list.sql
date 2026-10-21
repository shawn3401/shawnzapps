-- One row per Opportunity Path submission for the Jots page. Safe to re-run.
-- Stage is the furthest section the agent has filled in (the jot is completed in stages).
set client_min_messages = warning;
drop view if exists public.jot_list;
create view public.jot_list with (security_invoker = true) as
select s.id, s.form_id, s.versions,
  concat_ws(' & ', nullif(trim(s.answers ->> '36'), ''), nullif(trim(s.answers ->> '37'), '')) as client,
  s.answers ->> '203' as client_type,
  s.answers ->> '70' as agent,
  s.answers ->> '41' as set_by,
  s.answers ->> '16' as source,
  s.answers -> '76' ->> 'datetime' as appt_for,
  case
    when s.answers ? '210' then 'Listing handoff'
    when s.answers ? '114' or s.answers ? '115' then 'Rep signed'
    when s.answers ? '139' or s.answers ? '226' then 'Rep requested'
    when s.answers ->> '200' = 'Yes' then 'Appointment held'
    when s.answers ->> '200' = 'No - Cancelled' then 'Cancelled'
    when s.answers ->> '200' = 'No - Rescheduled' then 'Rescheduled'
    when s.answers ? '75' or s.answers ? '76' then 'Appointment set'
    else 'New'
  end as stage,
  s.jot_created_at as created,
  coalesce(s.jot_updated_at, s.jot_created_at) as updated,
  lower(concat_ws(' ', s.answers ->> '36', s.answers ->> '37', s.answers ->> '12', s.answers ->> '44',
    s.answers ->> '70', s.answers ->> '41', s.answers ->> '191', s.answers ->> '11')) as search
from public.jot_submissions s;
revoke all on public.jot_list from anon;
grant select on public.jot_list to authenticated;
notify pgrst, 'reload schema';
