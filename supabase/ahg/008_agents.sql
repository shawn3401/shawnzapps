-- Agents: view-only access to their own sales (Shawn, Oct 21, 2026). Safe to re-run.
-- An agent's sales are those where they're the primary agent OR on the commission split, and they
-- see the whole sale, including every row of the split table. Agents never write anything: the
-- existing "staff all" policies are the only write policies. The agent must be linked to a team
-- member on the Team page (app_users.team_member_id).
set client_min_messages = warning;

create or replace function public.my_team_member() returns integer
language sql stable security definer set search_path = public as $$
  select team_member_id from public.app_users
  where email = lower(auth.jwt() ->> 'email') and active and role = 'agent'
$$;
revoke all on function public.my_team_member() from anon;
grant execute on function public.my_team_member() to authenticated;

-- The sales an agent may see. security definer so it can look across splits without recursion.
create or replace function public.my_sale_ids() returns setof integer
language sql stable security definer set search_path = public as $$
  select s.sale_id from public.sales s where s.primary_sales_rep = (select public.my_team_member())
  union
  select t.sales_id from public.sharedat_team_level t where t.team_level_sales_rep = (select public.my_team_member())
$$;
revoke all on function public.my_sale_ids() from anon;
grant execute on function public.my_sale_ids() to authenticated;

drop policy if exists "agent reads own sales" on public.sales;
create policy "agent reads own sales" on public.sales for select to authenticated
  using ((select public.my_team_member()) is not null and sale_id in (select public.my_sale_ids()));

drop policy if exists "agent reads splits on own sales" on public.sharedat_team_level;
create policy "agent reads splits on own sales" on public.sharedat_team_level for select to authenticated
  using ((select public.my_team_member()) is not null and sales_id in (select public.my_sale_ids()));

drop policy if exists "agent reads lenders on own sales" on public.lender_approvals;
create policy "agent reads lenders on own sales" on public.lender_approvals for select to authenticated
  using ((select public.my_team_member()) is not null and sale in (select public.my_sale_ids()));

-- Leads: the agent's own (lead owner) and the lead behind each of their sales.
drop policy if exists "agent reads own leads" on public.leads;
create policy "agent reads own leads" on public.leads for select to authenticated
  using ((select public.my_team_member()) is not null and (
    sales_rep = (select public.my_team_member())
    or id in (select s.client_name from public.sales s where s.sale_id in (select public.my_sale_ids()))));

-- Lists the forms need to show names (no client data in these).
do $$
declare t text;
begin
  foreach t in array array['team_members', 'roles', 'lead_source', 'city_list', 'lenders', 'loan_officer', 'office_list', 'split_matrix'] loop
    execute format('drop policy if exists "agent reads list" on public.%I', t);
    execute format('create policy "agent reads list" on public.%I for select to authenticated using ((select public.my_team_member()) is not null)', t);
  end loop;
end $$;

notify pgrst, 'reload schema';
