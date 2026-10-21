-- Anderson Hicks Group project (ref pjfiyfljkzcvfvcrdrcj): who can sign in and see the data.
set client_min_messages = warning;
-- Safe to re-run. Run it after ahg-tools/import/access_import.py has created the copied tables,
-- and again after that script adds a table.

-- The team list. Signing in with Google proves an andersonhicks.com address; this list decides
-- what that person sees. Not copied from Access, so a data refresh never touches it.
create table if not exists public.app_users (
  email text primary key check (email = lower(email)),
  name text not null,
  role text not null check (role in ('admin', 'staff', 'agent')),
  team_member_id integer,           -- team_members.id, for agents (only their own sales, later)
  active boolean not null default true,
  added_at timestamptz not null default now()
);
alter table public.app_users enable row level security;
revoke all on public.app_users from anon;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.app_users
  where email = lower(auth.jwt() ->> 'email') and active
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() in ('admin', 'staff'), false)
$$;

revoke all on function public.my_role() from anon;
revoke all on function public.is_staff() from anon;
grant execute on function public.my_role() to authenticated;
grant execute on function public.is_staff() to authenticated;

drop policy if exists "own row or staff" on public.app_users;
create policy "own row or staff" on public.app_users for select to authenticated
  using (email = lower((select auth.jwt()) ->> 'email') or (select public.is_staff()));
grant select on public.app_users to authenticated;

-- Every table copied from Access (commented 'access:<name>' by the import script):
-- staff and admins read and write everything, the same as Access today. Agents get nothing
-- until their own-sales rules are written.
do $$
declare t text;
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and obj_description(c.oid, 'pg_class') like 'access:%'
      -- the team tables are admin-only to change; 016_team_members.sql sets their policies
      and c.relname not in ('team_members', 'team_membersin_roles', 'team_member_settings')
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop policy if exists "staff all" on public.%I', t);
    execute format('create policy "staff all" on public.%I for all to authenticated using ((select public.is_staff())) with check ((select public.is_staff()))', t);
  end loop;
end $$;

insert into public.app_users (email, name, role)
values ('shawn@andersonhicks.com', 'Shawn Anderson', 'admin')
on conflict (email) do nothing;

notify pgrst, 'reload schema';
