-- Goals (Shawn, Oct 21, 2026): each person's yearly goals, tied to the team member, not a typed
-- name. Replaces Access's Goals table (matched by name, so typos like "Kylew Waford" split one
-- person's goals) and the "Agent Goal Verification and Upload Tool" Google Sheet with its upload.
-- Same shape as Access (one row per person, year, metric, with Access's metric names) so the
-- reports read it the way they read Goals. The Goals page types the inputs and works out the rest
-- (the sheet's math, with the appointment split fixed; see the page's goalCalc()).
-- The team's goals are on the "Anderson Hicks" team member, Commission Dollars there being team
-- GCI; an agent's Commission Dollars is their own income (their 50% of gross).
-- Admins change goals; staff read them all; an agent reads only their own. Safe to re-run.
-- Run before 012_dlr.sql and 014_hustle.sql are used (both read goal_values).
set client_min_messages = warning;

create table if not exists public.goal_values (
  team_member_id integer not null,
  goal_year integer not null,
  metric text not null,
  goal numeric,
  updated_at timestamptz not null default now(),
  updated_by text default lower(auth.jwt() ->> 'email'),
  primary key (team_member_id, goal_year, metric)
);
alter table public.goal_values enable row level security;
revoke all on public.goal_values from anon;
grant select on public.goal_values to authenticated;
drop policy if exists "staff read" on public.goal_values;
drop policy if exists "agent reads own" on public.goal_values;
create policy "staff read" on public.goal_values for select to authenticated using ((select public.is_staff()));
create policy "agent reads own" on public.goal_values for select to authenticated using (team_member_id = (select public.my_team_member()));

-- One-time copy of Access's Goals (every year), names matched to team members. Spellings that
-- don't match the team list: "Adri Godfrey " (trailing space), Casey, Kyle, and Chris below.
-- Alexis Brazil (2023) and Madison Bower (2021-22) match no one and stay only in Access's table.
insert into public.goal_values (team_member_id, goal_year, metric, goal, updated_by)
select distinct on (tm.id, g.goal_year, g.metric) tm.id, g.goal_year, g.metric, g.goal, 'access'
from public.goals g
join public.team_members tm on lower(tm.team_member_name) = lower(trim(case trim(g.team_member)
  when 'Caseyj Johnston' then 'CaseyJ Johnston' when 'Casey Johnston' then 'CaseyJ Johnston'
  when 'Kylew Waford' then 'KyleW Waford' when 'Kylw Waford' then 'KyleW Waford'
  when 'Chris Moline' then 'ChrisM Moline' else g.team_member end))
where g.goal_year > 0 and g.goal is not null
  and not exists (select 1 from public.goal_values)
order by tm.id, g.goal_year, g.metric, g.id desc;

-- Save goals for one year: [{member, values: {metric: goal}}]. Each person's goals for that year
-- are replaced as a whole. Admins only.
create or replace function public.goal_save(p_year integer, p_plans jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare pl jsonb; n int := 0;
begin
  if not public.is_admin() then raise exception 'Only admins can change goals.'; end if;
  for pl in select * from jsonb_array_elements(p_plans) loop
    delete from goal_values where team_member_id = (pl ->> 'member')::int and goal_year = p_year;
    insert into goal_values (team_member_id, goal_year, metric, goal)
    select (pl ->> 'member')::int, p_year, key, nullif(value, 'null')::text::numeric
    from jsonb_each(pl -> 'values') where value <> 'null'::jsonb;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.goal_save(integer, jsonb) from public, anon;
grant execute on function public.goal_save(integer, jsonb) to authenticated;

create or replace function public.goal_remove(p_member integer, p_year integer) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only admins can change goals.'; end if;
  delete from goal_values where team_member_id = p_member and goal_year = p_year;
end $$;
revoke all on function public.goal_remove(integer, integer) from public, anon;
grant execute on function public.goal_remove(integer, integer) to authenticated;

notify pgrst, 'reload schema';
