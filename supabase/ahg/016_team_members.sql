-- Team page (Shawn, Oct 21, 2026, after Liz named adding and removing agents as a top pain point):
-- one page for every team member, past and present, with their role history, bonuses, Jotform
-- name, sign-in, and hustle board switch. Admins only make changes; staff can read. Safe to re-run.
-- Run after 001_access.sql (which leaves these three tables to this file) and 014_hustle.sql.
set client_min_messages = warning;

-- Admins change the team tables copied from Access; staff read them (agents keep their read
-- policy from 008_agents.sql for names).
do $$
declare t text;
begin
  foreach t in array array['team_members', 'team_membersin_roles', 'team_member_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists "staff all" on public.%I', t);
    execute format('drop policy if exists "staff read" on public.%I', t);
    execute format('drop policy if exists "admins write" on public.%I', t);
    execute format('drop policy if exists "admins change" on public.%I', t);
    execute format('drop policy if exists "admins remove" on public.%I', t);
    execute format('create policy "staff read" on public.%I for select to authenticated using ((select public.is_staff()))', t);
    execute format('create policy "admins write" on public.%I for insert to authenticated with check ((select public.is_admin()))', t);
    execute format('create policy "admins change" on public.%I for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t);
    execute format('create policy "admins remove" on public.%I for delete to authenticated using ((select public.is_admin()))', t);
  end loop;
end $$;

-- Left off the Agent hustle board. Not copied from Access, so a refresh keeps it.
create table if not exists public.hustle_hidden (
  team_member_id integer primary key,
  added_at timestamptz not null default now()
);
alter table public.hustle_hidden enable row level security;
revoke all on public.hustle_hidden from anon;
grant select, insert, delete on public.hustle_hidden to authenticated;
drop policy if exists "team reads" on public.hustle_hidden;
drop policy if exists "admins add" on public.hustle_hidden;
drop policy if exists "admins remove" on public.hustle_hidden;
create policy "team reads" on public.hustle_hidden for select to authenticated using ((select public.is_staff()));
create policy "admins add" on public.hustle_hidden for insert to authenticated with check ((select public.is_admin()));
create policy "admins remove" on public.hustle_hidden for delete to authenticated using ((select public.is_admin()));
-- Mike Hicks (on the owner scorecard instead) and the "Anderson Hicks" house account, as the
-- workbook's active-agent list had them.
insert into public.hustle_hidden (team_member_id)
select id from public.team_members where team_member_name in ('Mike Hicks', 'Anderson Hicks')
on conflict do nothing;

-- Jotform names: admins add and remove them on the Team page (the sync still writes nothing here).
grant insert, update, delete on public.jot_people to authenticated;
drop policy if exists "admins add" on public.jot_people;
drop policy if exists "admins change" on public.jot_people;
drop policy if exists "admins remove" on public.jot_people;
create policy "admins add" on public.jot_people for insert to authenticated with check ((select public.is_admin()));
create policy "admins change" on public.jot_people for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admins remove" on public.jot_people for delete to authenticated using ((select public.is_admin()));

-- Add a team member in one step: the person, their first role, and optionally their Jotform name,
-- sign-in, and hustle board switch. All or nothing.
create or replace function public.team_member_add(p jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare v_id int; v_name text := trim(p ->> 'name'); v_start date := nullif(p ->> 'start', '')::date;
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
  if coalesce(trim(p ->> 'email'), '') <> '' then
    insert into app_users (email, name, role, team_member_id) values (lower(trim(p ->> 'email')), v_name, coalesce(p ->> 'access', 'agent'), v_id);
  end if;
  if coalesce((p ->> 'hide_hustle')::boolean, false) then insert into hustle_hidden (team_member_id) values (v_id); end if;
  return v_id;
end $$;
revoke all on function public.team_member_add(jsonb) from public, anon;
grant execute on function public.team_member_add(jsonb) to authenticated;

-- Left the team: not active, open roles end on that day, sign-in off. History stays.
create or replace function public.team_member_leave(p_id integer, p_day date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only admins can do this.'; end if;
  if exists (select 1 from app_users where team_member_id = p_id and email = lower(auth.jwt() ->> 'email')) then
    raise exception 'You can''t mark yourself as gone. Ask another admin.';
  end if;
  update team_members set active = 'No' where id = p_id;
  update team_membersin_roles set role_end_date = p_day where team_member = p_id and role_end_date is null;
  update app_users set active = false where team_member_id = p_id;
end $$;
revoke all on function public.team_member_leave(integer, date) from public, anon;
grant execute on function public.team_member_leave(integer, date) to authenticated;

notify pgrst, 'reload schema';
