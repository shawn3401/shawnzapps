-- What the Sales - East Idaho form needs. Safe to re-run, and survives a data refresh
-- (the import script empties and reloads rows but keeps tables, defaults, and views).
set client_min_messages = warning;

-- Field defaults from the Access tables (mdb-prop), so a new sale, split, or lender row
-- starts the way it does in Access.
alter table public.sales
  alter column agent_concessions_not_on_hud set default 0,
  alter column next_split set default 0.25,
  alter column reo set default false,
  alter column referralon_hud_agent set default 'NA',
  alter column referralon_hud_percent set default 0,
  alter column steve_percent set default 0,
  alter column shawn_percent set default 0,
  alter column janell_percent set default 0,
  alter column charitable_donations set default 0,
  alter column commissions_pd_on_concessions set default true,
  alter column commissionis_flat_amount set default false,
  alter column market_center_charges set default 0,
  alter column market_center_split set default 0,
  alter column transaction_fees_bonuses set default 0,
  alter column other_hud_commission_deduction set default 0,
  alter column outside_agent_referral_percent set default 0,
  alter column paidat_mc_level_percent set default 0,
  alter column inspection set default true,
  alter column inspection_on_calendar set default false;

alter table public.lender_approvals
  alter column closeon_time set default true,
  alter column communication_rating set default 0,
  alter column numberof_lender_forced_extensions set default 0,
  alter column open_date set default (current_date);

alter table public.sharedat_team_level
  alter column team_level_sales_rep_share_percent set default 1,
  alter column team_level_kw_split_percent set default 0,
  alter column agent_brokerage_dollar set default 0,
  alter column agent_donation set default 0,
  alter column agent_royalty_dollar set default 0;

-- The form's search, as in Access query SalesforSalesForm-EastIdaho: any part of the client's
-- name, the address, the file number, the lead id, or the sale id. Inner join on the primary rep,
-- as in Access. No office filter: one location now (Shawn, Oct 20, 2026), so the page searches
-- every sale. security_invoker so the table policies apply.
drop view if exists public.sales_search;
create view public.sales_search with (security_invoker = true) as
select s.sale_id, s.address, s.city, s.sale_type, s.contract_date, s.current_projected_close_date,
       s.termination_date, s.file_number, s.client_name as lead_id, l.lead_name,
       tm.team_member_name as agent,
       -- Status from the key dates, the rule Access's own queries use (Sales-Open-ForReport,
       -- HistoricalSalesReport): a termination date means Terminated, else a settlement date means
       -- Closed, else Pending. Same rule as statusOf() in ahg-tools/index.html.
       case when s.termination_date is not null then 'Terminated'
            when s.actual_settlement_date is not null then 'Closed'
            else 'Pending' end as status,
       concat_ws(' ', l.lead_name, s.address, s.file_number, l.id::text, s.sale_id::text) as search
from public.sales s
left join public.leads l on l.id = s.client_name
join public.team_members tm on tm.id = s.primary_sales_rep;

revoke all on public.sales_search from anon;
grant select on public.sales_search to authenticated;

notify pgrst, 'reload schema';
