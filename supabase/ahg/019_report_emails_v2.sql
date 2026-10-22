-- Report distribution, second shape (Shawn, Oct 22, 2026): an EMAIL is what gets sent. It has a
-- subject (name), one or more reports stacked in order (bundling), who gets it (groups from the Team
-- page plus typed addresses), when, test or live, on or off, and it skips Idaho holidays by default.
-- Groups: 'agents' (active team members whose role is Agent), 'staff' and 'admins' (sign-in access),
-- 'role:<id>' (active team members in that team role). A group resolves to work emails when the
-- email is sent, so adding or removing someone on the Team page changes who gets it.
-- Personal copies per person (each agent their own version) are for later. Safe to re-run.
set client_min_messages = warning;

-- Work email per team member (for report emails), kept apart from Access's tables so a refresh keeps it.
create table if not exists public.team_member_emails (
  team_member_id integer primary key,
  email text not null unique check (email = lower(email) and email like '%@andersonhicks.com')
);
alter table public.team_member_emails enable row level security;
revoke all on public.team_member_emails from anon;
grant select, insert, update, delete on public.team_member_emails to authenticated;
drop policy if exists "staff read" on public.team_member_emails;
drop policy if exists "admins add" on public.team_member_emails;
drop policy if exists "admins change" on public.team_member_emails;
drop policy if exists "admins remove" on public.team_member_emails;
create policy "staff read" on public.team_member_emails for select to authenticated using ((select public.is_staff()));
create policy "admins add" on public.team_member_emails for insert to authenticated with check ((select public.is_admin()));
create policy "admins change" on public.team_member_emails for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admins remove" on public.team_member_emails for delete to authenticated using ((select public.is_admin()));
-- start from the sign-ins already linked to a team member
insert into public.team_member_emails (team_member_id, email)
select team_member_id, email from public.app_users where team_member_id is not null
on conflict do nothing;

alter table public.report_distributions add column if not exists reports text[];
alter table public.report_distributions add column if not exists audiences text[] not null default '{}';
alter table public.report_distributions add column if not exists skip_holidays boolean not null default true;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'report_distributions' and column_name = 'report') then
    update public.report_distributions set reports = array[report] where reports is null;
    -- the name is now the email's subject
    update public.report_distributions set name = 'Daily Leadership Reports' where report = 'dlr' and name = 'Leadership team';
    update public.report_distributions set name = 'Agent Hustle Board', audiences = '{agents}' where report = 'hustle' and name = 'All agents';
    alter table public.report_distributions drop column report;
  end if;
end $$;
alter table public.report_distributions alter column reports set not null;
alter table public.report_distributions drop constraint if exists report_distributions_reports_check;
alter table public.report_distributions add constraint report_distributions_reports_check
  check (cardinality(reports) > 0 and reports <@ array['dlr', 'hustle', 'tracker']);

-- Who an email goes to right now: its groups' work emails plus its typed addresses.
create or replace function public.report_recipients(p_audiences text[], p_extra text[]) returns text[]
language sql stable security definer set search_path = public as $$
  with tm as (
    select t.id, t.current_role, coalesce(e.email, u.email) as email
    from team_members t
    left join team_member_emails e on e.team_member_id = t.id
    left join app_users u on u.team_member_id = t.id and u.active
    where t.active = 'Yes'),
  picked as (
    select tm.email from tm join roles r on r.id = tm.current_role where 'agents' = any(p_audiences) and r.role_name = 'Agent'
    union select tm.email from tm where tm.current_role::text = any(select substr(a, 6) from unnest(p_audiences) a where a like 'role:%')
    union select email from app_users where active and role = 'staff' and 'staff' = any(p_audiences)
    union select email from app_users where active and role = 'admin' and 'admins' = any(p_audiences)
    union select lower(trim(x)) from unnest(coalesce(p_extra, '{}')) x)
  select coalesce(array_agg(distinct email order by email) filter (where email is not null and email <> ''), '{}') from picked
$$;
revoke all on function public.report_recipients(text[], text[]) from public, anon;
grant execute on function public.report_recipients(text[], text[]) to authenticated, service_role;

-- Who in a group has no work email yet (so the page can say so).
create or replace function public.report_missing_emails(p_audiences text[]) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(t.team_member_name order by t.team_member_name), '{}')
  from team_members t join roles r on r.id = t.current_role
  where t.active = 'Yes'
    and (('agents' = any(p_audiences) and r.role_name = 'Agent') or t.current_role::text = any(select substr(a, 6) from unnest(p_audiences) a where a like 'role:%'))
    and not exists (select 1 from team_member_emails e where e.team_member_id = t.id)
    and not exists (select 1 from app_users u where u.team_member_id = t.id and u.active)
$$;
revoke all on function public.report_missing_emails(text[]) from public, anon;
grant execute on function public.report_missing_emails(text[]) to authenticated;

-- Adding a team member also takes their work email (and gives a sign-in only when asked).
create or replace function public.team_member_add(p jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare v_id int; v_name text := trim(p ->> 'name'); v_start date := nullif(p ->> 'start', '')::date;
  v_email text := lower(nullif(trim(p ->> 'email'), ''));
begin
  if not public.is_admin() then raise exception 'Only admins can add team members.'; end if;
  if coalesce(v_name, '') = '' then raise exception 'Fill in the name.'; end if;
  if exists (select 1 from team_members where lower(team_member_name) = lower(v_name)) then
    raise exception '% is already on the team list (maybe as a former team member).', v_name;
  end if;
  insert into team_members (team_member_name, active, "current_role", company_start_date, agent_split_level)
  values (v_name, 'Yes', (p ->> 'role')::int, v_start, nullif(p ->> 'split', ''))
  returning id into v_id;
  insert into team_membersin_roles (team_member, role, role_start_date) values (v_id, (p ->> 'role')::int, v_start);
  if coalesce(trim(p ->> 'jot'), '') <> '' then
    if exists (select 1 from jot_people where lower(jot_name) = lower(trim(p ->> 'jot'))) then
      raise exception 'The Jotform name "%" is already used by someone else.', trim(p ->> 'jot');
    end if;
    insert into jot_people (jot_name, team_member_id) values (trim(p ->> 'jot'), v_id);
  end if;
  if v_email is not null then
    insert into team_member_emails (team_member_id, email) values (v_id, v_email);
    if coalesce((p ->> 'signin')::boolean, false) then
      insert into app_users (email, name, role, team_member_id) values (v_email, v_name, coalesce(p ->> 'access', 'agent'), v_id);
    end if;
  end if;
  if coalesce((p ->> 'hide_hustle')::boolean, false) then insert into hustle_hidden (team_member_id) values (v_id); end if;
  return v_id;
end $$;
revoke all on function public.team_member_add(jsonb) from public, anon;
grant execute on function public.team_member_add(jsonb) to authenticated;

notify pgrst, 'reload schema';
