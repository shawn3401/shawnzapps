-- Start dates (Shawn, Oct 25, 2026): a team member with no company start date gets the earliest
-- start date in their role history. Dates already typed are kept, even where a role starts earlier.
-- An Access refresh reloads team_members, so ahg-tools/import/access_import.py runs this again after
-- every load. Safe to re-run.
set client_min_messages = warning;

create or replace function public.fill_start_dates() returns integer
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update team_members t set company_start_date = r.first_role
  from (select team_member, min(role_start_date) first_role from team_membersin_roles
        where role_start_date is not null group by 1) r
  where r.team_member = t.id and t.company_start_date is null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.fill_start_dates() from public, anon, authenticated;

select public.fill_start_dates();
