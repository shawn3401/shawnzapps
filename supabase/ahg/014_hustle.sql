-- Agent Hustle Board (Shawn, Oct 21, 2026): the daily board that goes to every agent. Rebuilt from
-- the KPI platform's AGTHUSTLE sheet (the scoreboard, columns AQ to BI) and DAM sheet (the
-- "Contracts:" goal box, rows 30 to 32). Safe to re-run.
-- Everyone on the team list sees it, agents included, because the board is sent to all agents. It
-- returns counts only, no client details, so it runs as security definer; agents still can't open
-- other agents' sales.
set client_min_messages = warning;

create or replace function public.hustle_board(p_today date default current_date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  t date := p_today; y0 date := date_trunc('year', p_today); y1 date := (date_trunc('year', p_today) + interval '1 year - 1 day')::date;
  m0 date := date_trunc('month', p_today); m1 date := (date_trunc('month', p_today) + interval '1 month - 1 day')::date;
  r90 date := p_today - 90; yest date := p_today - 1;
  goal numeric; box jsonb; rows jsonb;
begin
  if public.my_role() is null then raise exception 'Not on the team list.'; end if;

  -- DAM "Contracts:" box: month goal = team contracts goal x season share; pace rounds up the share of
  -- the month passed; achieved = this month's contracts, referrals left out.
  select round(g.goal * sa.share) into goal from goals g, season_allocation sa
  where g.team_member = 'Anderson Hicks' and g.metric = 'Contracts' and g.goal_year = extract(year from t) and sa.month = extract(month from t);
  select jsonb_build_object('goal', goal,
    'pace', ceil(coalesce(goal, 0) * (t - m0)::numeric / extract(day from m1)),
    'achieved', count(*),
    'per_day', round(count(*)::numeric / nullif(t - m0, 0), 1),
    'daily_goal', round(coalesce(goal, 0) / nullif(m1 - m0, 0), 1))
  into box from sales where sale_type <> 'Referral' and contract_date::date between m0 and m1;
  box := box || jsonb_build_object('gap', (box ->> 'achieved')::int - (box ->> 'pace')::int);

  -- AGTHUSTLE scoreboard, one row per active agent. Sales count for their primary agent; leads for
  -- the lead owner. Windows as in the workbook: R90 = the 90 days before today (sales through
  -- yesterday, leads through today), MTD = this month through today.
  with ag as (
    select tm.id, tm.team_member_name as name, split_part(tm.team_member_name, ' ', 1) as first
    from team_members tm join roles r on r.id = tm.current_role
    where tm.active = 'Yes' and r.role_name = 'Agent'
      -- the workbook's active-agent list leaves out the owner (Mike is on the leadership owner
      -- scorecard instead) and the "Anderson Hicks" house account, both set up as agents in Access
      and tm.team_member_name not in ('Mike Hicks', 'Anderson Hicks')),
  s as (select primary_sales_rep a, sale_type, contract_date::date c, actual_settlement_date::date st, termination_date, checkto_team_date, purchase_price from sales),
  l as (select sales_rep a, representation_contract_signed_date::date rep,
          (case when third_appt_set_on_date is not null then third_appt_date when second_appt_set_on_date is not null then second_appt_date else first_appt_date end)::date held,
          (case when third_appt_set_on_date is not null then third_appt_set_on_date when second_appt_set_on_date is not null then second_appt_set_on_date else first_appt_set_on_date end)::date set_on
        from leads),
  x as (
    select ag.id, ag.name, ag.first,
      (select count(*) from s where a = ag.id and c is not null and checkto_team_date is null and termination_date is null) as pendings,
      (select count(*) from s where a = ag.id and st between y0 and y1) as closings_year,
      (select coalesce(sum(purchase_price), 0) from s where a = ag.id and st between y0 and y1) as closed_volume,
      (select count(*) from s where a = ag.id and st between r90 and yest) as closings_r90,
      (select count(*) from s where a = ag.id and sale_type <> 'Referral' and c between y0 and y1) as contracts_ytd,
      (select count(*) from s where a = ag.id and sale_type <> 'Referral' and c between r90 and yest) as contracts_r90,
      (select count(*) from s where a = ag.id and sale_type <> 'Referral' and c between m0 and t) as contracts_month,
      (select t - max(c) from s where a = ag.id) as days_since_contract,
      (select count(*) from s where a = ag.id and c between r90 and yest) as contracts_r90_all,
      (select count(*) from l where a = ag.id and rep between r90 and yest) as reps_r90_to_yest,
      (select count(*) from l where a = ag.id and rep between r90 and t) as reps_r90,
      (select count(*) from l where a = ag.id and rep between m0 and t) as reps_month,
      (select count(*) from l where a = ag.id and held between r90 and t) as taken_r90,
      (select count(*) from l where a = ag.id and held between m0 and t) as taken_month,
      (select count(*) from l where a = ag.id and set_on between r90 and t) as set_r90,
      (select count(*) from l where a = ag.id and set_on between m0 and t) as set_month
    from ag)
  select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'first', first, 'pendings', pendings, 'closings_year', closings_year, 'closed_volume', closed_volume,
      'closings_r90', closings_r90,
      'contract_to_close', case when contracts_ytd = 0 then 0 else round(closings_year::numeric / contracts_ytd, 4) end,
      'contracts_ytd', contracts_ytd, 'contracts_r90', contracts_r90, 'contracts_month', contracts_month,
      'days_since_contract', days_since_contract,
      'rep_to_contract', case when reps_r90_to_yest = 0 then null else round(contracts_r90_all::numeric / reps_r90_to_yest, 4) end,
      'reps_r90', reps_r90, 'reps_month', reps_month,
      'appt_to_rep', case when taken_r90 = 0 then 0 else round(reps_r90::numeric / taken_r90, 4) end,
      'taken_r90', taken_r90, 'taken_month', taken_month,
      'take_rate', case when set_r90 = 0 then 0 else round(taken_r90::numeric / set_r90, 4) end,
      'set_r90', set_r90, 'set_month', set_month) order by contracts_ytd desc, closings_year desc, name)
  into rows from x;

  return jsonb_build_object('today', t, 'box', box, 'agents', coalesce(rows, '[]'));
end $$;
revoke all on function public.hustle_board(date) from public, anon;
grant execute on function public.hustle_board(date) to authenticated;
notify pgrst, 'reload schema';
