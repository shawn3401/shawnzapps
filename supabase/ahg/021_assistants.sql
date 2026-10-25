-- Assistants (Shawn, Oct 25, 2026): Lisa Meyers assists Eric Shippen, so she sees her own sales and
-- leads plus Eric's, but not anyone else's (not Riley's). A sign-in with Agent access can now "also
-- see" other team members: app_users.also_sees. Everything an agent could see for themself (sales
-- as primary agent or on the split, the whole split table, lenders, their leads and the leads behind
-- those sales, goals) now covers each person in that list too. Still view only. Safe to re-run.
set client_min_messages = warning;

alter table public.app_users add column if not exists also_sees integer[] not null default '{}';

-- The team members whose records this agent sign-in may see: their own, plus anyone they assist.
create or replace function public.my_team_members() returns setof integer
language sql stable security definer set search_path = public as $$
  select unnest(array[team_member_id] || also_sees) from public.app_users
  where email = lower(auth.jwt() ->> 'email') and active and role = 'agent' and team_member_id is not null
$$;
revoke all on function public.my_team_members() from anon;
grant execute on function public.my_team_members() to authenticated;

create or replace function public.my_sale_ids() returns setof integer
language sql stable security definer set search_path = public as $$
  select s.sale_id from public.sales s where s.primary_sales_rep in (select public.my_team_members())
  union
  select t.sales_id from public.sharedat_team_level t where t.team_level_sales_rep in (select public.my_team_members())
$$;
revoke all on function public.my_sale_ids() from anon;
grant execute on function public.my_sale_ids() to authenticated;

drop policy if exists "agent reads own leads" on public.leads;
create policy "agent reads own leads" on public.leads for select to authenticated
  using ((select public.my_team_member()) is not null and (
    sales_rep in (select public.my_team_members())
    or id in (select s.client_name from public.sales s where s.sale_id in (select public.my_sale_ids()))));

drop policy if exists "agent reads own" on public.goal_values;
create policy "agent reads own" on public.goal_values for select to authenticated
  using (team_member_id in (select public.my_team_members()));

notify pgrst, 'reload schema';
