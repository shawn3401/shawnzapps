-- Daily Leadership Dashboard (DLR), rebuilt from the Excel "AHGReportingPlatform" workbook's DLR1
-- sheet (Shawn, Oct 21, 2026). Safe to re-run; survives a data refresh.
set client_min_messages = warning;

-- The workbook's Reference sheet, "Season Allocation": the share of a year's goal that falls in
-- each month. Every DLR month target is year goal x this share ("Everything Seasonally Adjusted").
create table if not exists public.season_allocation (month integer primary key check (month between 1 and 12), share numeric not null);
insert into public.season_allocation values
  (1, 0.063), (2, 0.072), (3, 0.07887323943661972), (4, 0.086), (5, 0.094), (6, 0.096),
  (7, 0.096), (8, 0.091), (9, 0.089), (10, 0.085), (11, 0.073), (12, 0.076)
on conflict (month) do update set share = excluded.share;
alter table public.season_allocation enable row level security;
revoke all on public.season_allocation from anon;
grant select on public.season_allocation to authenticated;
drop policy if exists "signed in read" on public.season_allocation;
create policy "signed in read" on public.season_allocation for select to authenticated using (true);

-- Gross Potential Commission of a sale: the Sales form's math (Access query SalesforSalesForm,
-- calc() in ahg-tools/index.html). The DLR's "GCI" is this number.
create or replace function public.sale_gpc(s public.sales) returns numeric language sql immutable as $$
  select case when s.commissionis_flat_amount then s.projected_commission_flat_amount + s.transaction_fees_bonuses
              else (case when s.commissions_pd_on_concessions then s.purchase_price else s.purchase_price - s.contract_concessions end)
                   * s.projected_commission_percent + s.transaction_fees_bonuses end
$$;

-- GCI by month: closed sales by settlement month, pending sales by projected close month,
-- terminated sales left out. Checked against the workbook Oct 21, 2026 (Oct 668,888.21).
create or replace view public.gci_by_month with (security_invoker = true) as
select date_trunc('month', coalesce(s.actual_settlement_date, s.current_projected_close_date))::date as month,
  sum(public.sale_gpc(s)) as gci,
  sum(public.sale_gpc(s)) filter (where s.actual_settlement_date is not null) as closed_gci,
  sum(public.sale_gpc(s)) filter (where s.actual_settlement_date is null) as pending_gci,
  count(*) as sales
from public.sales s
where s.termination_date is null and coalesce(s.actual_settlement_date, s.current_projected_close_date) is not null
group by 1;
revoke all on public.gci_by_month from anon;
grant select on public.gci_by_month to authenticated;

-- Everything the DLR shows, for one day (default today), as JSON: the page and the daily email both
-- read this, so they can't disagree. Rules from the workbook's DLR1 and Reference formulas:
--  * month target = Anderson Hicks year goal x season share; months shown: GCI the current month and
--    the next two (on the 1st, last month first); other tiles last month and this month
--  * this month's pace = target x calendar days passed / days in month (rounded for counts)
--  * year pace = year goal x (shares of finished months + this month's share x weekdays passed
--    through yesterday / weekdays in the month)
--  * GCI: closed by settlement month plus pendings by projected close month; year = closed so far
--  * closings / contracts: sales by settlement / contract date, referrals left out
--  * reps signed: leads by rep signed date, buyer and seller; appts held: by the most recent
--    consultation's appointment date, buyer and seller; appts set: by the most recent consultation's
--    set-on date, team-generated vs agent-generated (credit = the lead owner), no goal
--  * new leads (Brivity) and profit (QuickBooks) come from outside Access: not built yet
create or replace function public.dlr_data(p_today date default current_date) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  y int := extract(year from p_today);
  this_m date := date_trunc('month', p_today);
  last_m date := (date_trunc('month', p_today) - interval '1 month')::date;
  gci_m date := case when extract(day from p_today) = 1 then last_m else this_m end;
  wd_passed numeric; wd_month numeric; prorate numeric; out jsonb := '{}'; g record; gj jsonb;
begin
  select count(*) filter (where d < p_today), count(*) into wd_passed, wd_month
  from generate_series(this_m, (this_m + interval '1 month' - interval '1 day')::date, '1 day') d where extract(isodow from d) < 6;
  select coalesce(sum(share) filter (where month < extract(month from p_today)), 0)
       + coalesce(sum(share) filter (where month = extract(month from p_today)), 0) * wd_passed / nullif(wd_month, 0)
  into prorate from season_allocation;

  -- year goals for the team
  select coalesce(jsonb_object_agg(metric, goal), '{}') into gj from goals where team_member = 'Anderson Hicks' and goal_year = y;

  -- GCI
  out := out || jsonb_build_object('gci', jsonb_build_object(
    'year_goal', (gj ->> 'Commission Dollars')::numeric,
    'month_goal', (gj ->> 'Commission Dollars')::numeric * (select share from season_allocation where month = extract(month from gci_m)),
    'months', (select jsonb_agg(jsonb_build_object('month', m, 'target', (gj ->> 'Commission Dollars')::numeric * (select share from season_allocation where month = extract(month from m)),
                 'actual', coalesce((select gci from gci_by_month where month = m), 0), 'closed', coalesce((select closed_gci from gci_by_month where month = m), 0)) order by m)
               from (select (gci_m + make_interval(months => i))::date m from generate_series(0, 2) i) x),
    'year', jsonb_build_object('target', (gj ->> 'Commission Dollars')::numeric,
               'pace', (gj ->> 'Commission Dollars')::numeric * prorate,
               'actual', coalesce((select sum(closed_gci) from gci_by_month where month >= make_date(y, 1, 1) and month < make_date(y + 1, 1, 1)), 0))));

  -- count tiles: last month and this month, plus the year
  for g in select * from (values
      ('closings', 'Closings'), ('contracts', 'Contracts'), ('reps', 'Reps Signed'), ('held', 'Appointments Taken'), ('set', null)) t(tile, metric) loop
    out := out || jsonb_build_object(g.tile, (
      select jsonb_build_object(
        'year_goal', coalesce((gj ->> g.metric)::numeric, 0),
        'month_goal', round(coalesce((gj ->> g.metric)::numeric, 0) * (select share from season_allocation where month = extract(month from this_m))),
        'months', jsonb_agg(jsonb_build_object('month', m,
            'target', round(coalesce((gj ->> g.metric)::numeric, 0) * (select share from season_allocation where month = extract(month from m))),
            'pace', case when m = this_m then round(coalesce((gj ->> g.metric)::numeric, 0) * (select share from season_allocation where month = extract(month from m))
                          * (p_today - m) / ((m + interval '1 month')::date - 1 - m)) else round(coalesce((gj ->> g.metric)::numeric, 0) * (select share from season_allocation where month = extract(month from m))) end,
            'a', public.dlr_count(g.tile, 'a', m, (m + interval '1 month')::date - 1),
            'b', public.dlr_count(g.tile, 'b', m, (m + interval '1 month')::date - 1)) order by m),
        'year', jsonb_build_object('target', coalesce((gj ->> g.metric)::numeric, 0),
            'pace', round(coalesce((gj ->> g.metric)::numeric, 0) * prorate),
            'a', public.dlr_count(g.tile, 'a', make_date(y, 1, 1), make_date(y, 12, 31)),
            'b', public.dlr_count(g.tile, 'b', make_date(y, 1, 1), make_date(y, 12, 31))))
      from (select last_m m union all select this_m) mm));
  end loop;
  return out || jsonb_build_object('today', p_today, 'prorate', prorate);
end $$;

-- One count for a DLR tile over a date range. 'a' and 'b' are the two parts of split tiles:
-- reps and appts held (a = buyer, b = seller), appts set (a = team generated, b = agent generated).
create or replace function public.dlr_count(p_tile text, p_part text, p_from date, p_to date) returns integer
language sql stable security invoker set search_path = public as $$
  with l as (
    select l.lead_type, l.representation_contract_signed_date::date as rep,
      (case when l.third_appt_set_on_date is not null then l.third_appt_date when l.second_appt_set_on_date is not null then l.second_appt_date else l.first_appt_date end)::date as held,
      (case when l.third_appt_set_on_date is not null then l.third_appt_set_on_date when l.second_appt_set_on_date is not null then l.second_appt_set_on_date else l.first_appt_set_on_date end)::date as set_on,
      case when l.team_member_credit = t.team_member_name then 'Agent' else 'Team' end as gen
    from leads l left join team_members t on t.id = l.sales_rep
    where p_tile in ('reps', 'held', 'set'))
  select case p_tile
    when 'closings' then (select count(*) from sales where p_part = 'a' and sale_type <> 'Referral' and actual_settlement_date::date between p_from and p_to)
    when 'contracts' then (select count(*) from sales where p_part = 'a' and sale_type <> 'Referral' and contract_date::date between p_from and p_to)
    when 'reps' then (select count(*) from l where lead_type = case p_part when 'a' then 'Buyer' else 'Seller' end and rep between p_from and p_to)
    when 'held' then (select count(*) from l where lead_type = case p_part when 'a' then 'Buyer' else 'Seller' end and held between p_from and p_to)
    when 'set' then (select count(*) from l where gen = case p_part when 'a' then 'Team' else 'Agent' end and set_on between p_from and p_to)
  end::integer
$$;
grant execute on function public.dlr_count(text, text, date, date) to authenticated;
grant execute on function public.dlr_data(date) to authenticated;
notify pgrst, 'reload schema';
