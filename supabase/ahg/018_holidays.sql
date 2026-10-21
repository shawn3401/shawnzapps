-- Business-day holidays follow Idaho law (Shawn, Oct 21, 2026). The Idaho REALTORS RE-21 Purchase
-- and Sale Agreement (section 26) counts business days as Monday to Friday, leaving out legal
-- holidays recognized by Idaho in Idaho Code 73-108: Jan 1; third Monday in January (Martin Luther
-- King Jr.-Idaho Human Rights Day); third Monday in February (Washington's Birthday); last Monday in
-- May (Memorial Day); July 4; first Monday in September (Labor Day); second Monday in October
-- (Columbus Day); Nov 11 (Veterans Day); fourth Thursday in November (Thanksgiving); Dec 25; and any
-- day the President or the Governor appoints. A holiday on a Saturday is observed the Friday before,
-- one on a Sunday the Monday after. Juneteenth is a federal holiday but NOT in 73-108.
-- The Settings page shows the list, imports a year from these rules, and adds or removes days by
-- hand (for a day the President or Governor appoints). Safe to re-run.
set client_min_messages = warning;

alter table public.holidays add column if not exists source text not null default 'manual';
alter table public.holidays add column if not exists added_by text default lower(auth.jwt() ->> 'email');
alter table public.holidays add column if not exists added_at timestamptz not null default now();

-- The days Idaho Code 73-108 makes legal holidays in year y, moved off weekends as the code says.
create or replace function public.idaho_holidays(y integer) returns table (day date, name text)
language sql immutable as $$
  with base(d, n) as (values
    (make_date(y, 1, 1), 'New Year''s Day'),
    ((make_date(y, 1, 1) + ((8 - extract(isodow from make_date(y, 1, 1))::int) % 7) + 14), 'Martin Luther King Jr.-Idaho Human Rights Day'),
    ((make_date(y, 2, 1) + ((8 - extract(isodow from make_date(y, 2, 1))::int) % 7) + 14), 'Washington''s Birthday (Presidents Day)'),
    ((make_date(y, 5, 31) - ((extract(isodow from make_date(y, 5, 31))::int + 6) % 7)), 'Memorial Day'),
    (make_date(y, 7, 4), 'Independence Day'),
    ((make_date(y, 9, 1) + ((8 - extract(isodow from make_date(y, 9, 1))::int) % 7)), 'Labor Day'),
    ((make_date(y, 10, 1) + ((8 - extract(isodow from make_date(y, 10, 1))::int) % 7) + 7), 'Columbus Day'),
    (make_date(y, 11, 11), 'Veterans Day'),
    ((make_date(y, 11, 1) + ((11 - extract(isodow from make_date(y, 11, 1))::int) % 7) + 21), 'Thanksgiving Day'),
    (make_date(y, 12, 25), 'Christmas Day'))
  select case extract(isodow from d) when 6 then d - 1 when 7 then d + 1 else d end,
         n || case when extract(isodow from d) in (6, 7) then ' (observed)' else '' end
  from base
$$;

-- Put a year's Idaho holidays in the list. Days added by hand stay. New Year's Day of the next year
-- on a Saturday is observed Dec 31 of this year, so it's included.
create or replace function public.holidays_import(p_year integer) returns integer
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_admin() then raise exception 'Only admins can change holidays.'; end if;
  if p_year < 2000 or p_year > 2100 then raise exception 'Pick a year between 2000 and 2100.'; end if;
  delete from holidays where source in ('idaho', 'workbook') and extract(year from day) = p_year;
  insert into holidays (day, name, source)
  select h.day, h.name, 'idaho' from (select * from idaho_holidays(p_year) union all select * from idaho_holidays(p_year + 1)) h
  where extract(year from h.day) = p_year
  on conflict (day) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.holidays_import(integer) from public, anon;
grant execute on function public.holidays_import(integer) to authenticated;

grant insert, update, delete on public.holidays to authenticated;
drop policy if exists "admins add" on public.holidays;
drop policy if exists "admins change" on public.holidays;
drop policy if exists "admins remove" on public.holidays;
create policy "admins add" on public.holidays for insert to authenticated with check ((select public.is_admin()));
create policy "admins change" on public.holidays for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admins remove" on public.holidays for delete to authenticated using ((select public.is_admin()));

-- One time (Oct 21, 2026): the list came from the Pending Tracker workbook's Lookups sheet. Checked
-- against 73-108 it had Juneteenth 2023-2026 (not an Idaho holiday), no weekend shifts (July 4, 2026
-- on a Saturday should make Friday July 3 the holiday; same for 2027 and 2028), and three typed
-- wrong in 2012-2013. Replaced 2011 through 2030 with the law's dates.
do $$
begin
  if not exists (select 1 from public.holidays where source in ('idaho', 'workbook')) then
    update public.holidays set source = 'workbook', added_by = null;
    delete from public.holidays where source = 'workbook' and day between '2011-01-01' and '2030-12-31';
    insert into public.holidays (day, name, source, added_by)
    select h.day, h.name, 'idaho', null from generate_series(2010, 2031) y, public.idaho_holidays(y) h
    where h.day between '2011-01-01' and '2030-12-31'
    on conflict (day) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';
