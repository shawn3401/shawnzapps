-- Team page: admins manage the team list (app_users) from AHG Tools. Safe to re-run.
set client_min_messages = warning;

-- Only andersonhicks.com addresses, so a typo can't add a stranger (Google sign-in is
-- limited to the Workspace anyway).
alter table public.app_users drop constraint if exists app_users_domain;
alter table public.app_users add constraint app_users_domain check (email like '%@andersonhicks.com');

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'admin', false)
$$;
revoke all on function public.is_admin() from anon;
grant execute on function public.is_admin() to authenticated;

drop policy if exists "admins add" on public.app_users;
drop policy if exists "admins change" on public.app_users;
drop policy if exists "admins remove" on public.app_users;
create policy "admins add" on public.app_users for insert to authenticated with check (public.is_admin());
create policy "admins change" on public.app_users for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins remove" on public.app_users for delete to authenticated using (public.is_admin());
grant insert, update, delete on public.app_users to authenticated;

-- Never leave the team with no active admin, and no one can demote or switch off themself
-- (another admin has to), so nobody locks the team out by accident.
create or replace function public.app_users_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare me text := lower(auth.jwt() ->> 'email');
begin
  if tg_op in ('UPDATE', 'DELETE') and old.email = me
     and (tg_op = 'DELETE' or new.role <> 'admin' or not new.active or new.email <> old.email) then
    raise exception 'You can''t remove your own admin access. Ask another admin.';
  end if;
  if tg_op = 'INSERT' or tg_op = 'UPDATE' then
    new.email := lower(trim(new.email));
    new.name := trim(new.name);
  end if;
  return coalesce(new, old);
end $$;

create or replace function public.app_users_keep_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.app_users where role = 'admin' and active) then
    raise exception 'The team needs at least one active admin.';
  end if;
  return null;
end $$;

drop trigger if exists app_users_guard on public.app_users;
create trigger app_users_guard before insert or update or delete on public.app_users
  for each row execute function public.app_users_guard();
drop trigger if exists app_users_keep_admin on public.app_users;
create trigger app_users_keep_admin after update or delete on public.app_users
  for each statement execute function public.app_users_keep_admin();

notify pgrst, 'reload schema';
