-- Pending Tracker (Shawn, Oct 21, 2026): the closing team's view of every pending sale with its
-- deadlines and what's done. Rebuilt from the Excel "PendingTracker - East Idaho" workbook, which
-- read Access query ExportPendingsEastIdaho. Safe to re-run; survives a data refresh.
set client_min_messages = warning;

-- Business-day holidays, copied from the workbook's Lookups sheet (2011 through 2026), plus the same
-- ten holidays for 2027 to 2030 added by AHG Tools. Loaded by ahg-tools/import (see CLAUDE.md).
create table if not exists public.holidays (day date primary key, name text not null);
alter table public.holidays enable row level security;
revoke all on public.holidays from anon;
grant select on public.holidays to authenticated;
drop policy if exists "signed in read" on public.holidays;
create policy "signed in read" on public.holidays for select to authenticated using (true);

-- Excel's WORKDAY(start, days, holidays): move that many business days forward (or back when
-- negative), skipping Saturdays, Sundays, and holidays. Blank days count as 0 (the start date), as in Excel.
create or replace function public.workday(p_start date, p_days integer) returns date
language plpgsql stable set search_path = public as $$
declare d date := p_start; step int := case when p_days < 0 then -1 else 1 end; left_ int := abs(coalesce(p_days, 0));
begin
  if p_start is null then return null; end if;
  while left_ > 0 loop
    d := d + step;
    if extract(isodow from d) < 6 and not exists (select 1 from holidays where day = d) then left_ := left_ - 1; end if;
  end loop;
  return d;
end $$;

-- The workbook's two settings (Lookups sheet): appraisal verified and closing scheduled are due
-- 5 business days before the close date.
create or replace view public.pending_tracker with (security_invoker = true) as
with p as (
  select s.*, l.lead_name,
    (select la.lender from lender_approvals la where la.sale = s.sale_id order by la.id desc limit 1) as cur_lender,
    (select la.loan_officer_linked from lender_approvals la where la.sale = s.sale_id order by la.id desc limit 1) as cur_lo
  from sales s left join leads l on l.id = s.client_name
  where s.actual_settlement_date is null and s.termination_date is null
), d as (
  select p.*,
    workday(contract_date::date, earnest_money_days) as em_due,
    workday(contract_date::date, loan_commitment_number_days) as lc_due,
    case when inspection then workday(contract_date::date, insepction_days) end as insp_due
  from p
)
select d.sale_id, d.client_name as lead_id, d.lead_name,
  -- last word of the lead name, as the workbook showed it
  regexp_replace(trim(d.lead_name), '^.*\s', '') as client_last_name,
  d.address, d.city, d.sale_type, d.primary_sales_rep, rep.team_member_name as agent, d.trans_cord, tc.team_member_name as tc,
  d.coop_agent, ln.lender_name as lender, lo.loan_officer, d.title_company,
  d.contract_date::date as contract_date,
  d.em_due, d.earnest_money_delivered::date as em_done,
  d.lc_due, d.loan_commitment_completed_date::date as lc_done,
  d.inspection, d.insp_due, d.inspection_transmittal_completed_date::date as insp_done,
  case when d.inspection then workday(coalesce(d.inspection_transmittal_completed_date::date, d.insp_due), d.inspection_seller_response_days) end as sr_due,
  d.inspection_seller_response_completed_date::date as sr_done,
  case when d.inspection then workday(coalesce(d.inspection_seller_response_completed_date::date,
         workday(coalesce(d.inspection_transmittal_completed_date::date, d.insp_due), d.inspection_seller_response_days)), d.inspection_buyer_response_days) end as br_due,
  d.inspection_buyer_response_completed_date::date as br_done,
  workday(d.current_projected_close_date::date, -5) as appraisal_due, d.appraisal_verified::date as appraisal_done,
  workday(d.current_projected_close_date::date, -5) as close_prep_due, d.closing_appointment_scheduled::date as close_prep_done,
  d.current_projected_close_date::date as close_date, d.actual_settlement_date::date as closed
from d
left join team_members rep on rep.id = d.primary_sales_rep
left join team_members tc on tc.id = d.trans_cord
left join lenders ln on ln.id = d.cur_lender
left join loan_officer lo on lo.id = d.cur_lo;
revoke all on public.pending_tracker from anon;
grant select on public.pending_tracker to authenticated;
notify pgrst, 'reload schema';
