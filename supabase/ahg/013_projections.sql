-- "Include in projections" (Shawn, Oct 21, 2026): a switch on each sale, on by default. Turned off,
-- a PENDING sale's GCI is left out of projections (big, soft deals Shawn doesn't want to plan on).
-- Once the sale closes it counts as closed GCI regardless. Only admins can flip it for now.
-- Kept in its own table, keyed by sale id, so a refresh from Access (which replaces sales rows)
-- doesn't wipe it. A row here means "left out". Safe to re-run.
set client_min_messages = warning;

create table if not exists public.projection_exclusions (
  sale_id integer primary key,
  excluded_by text not null default lower(auth.jwt() ->> 'email'),
  excluded_at timestamptz not null default now()
);
alter table public.projection_exclusions enable row level security;
revoke all on public.projection_exclusions from anon, authenticated;
grant select on public.projection_exclusions to authenticated;
grant insert, delete on public.projection_exclusions to authenticated;
drop policy if exists "staff read" on public.projection_exclusions;
drop policy if exists "admins add" on public.projection_exclusions;
drop policy if exists "admins remove" on public.projection_exclusions;
create policy "staff read" on public.projection_exclusions for select to authenticated using ((select public.is_staff()));
create policy "admins add" on public.projection_exclusions for insert to authenticated with check ((select public.is_admin()));
create policy "admins remove" on public.projection_exclusions for delete to authenticated using ((select public.is_admin()));

-- The big W 17th deal, both sides (Marco Diaz 9249, Whistling Pig 9246), per Shawn.
insert into public.projection_exclusions (sale_id, excluded_by) values (9249, 'shawn@andersonhicks.com'), (9246, 'shawn@andersonhicks.com')
on conflict (sale_id) do nothing;

-- GCI by month, now leaving out pending sales switched off (and showing what was left out).
drop view if exists public.gci_by_month cascade;
create view public.gci_by_month with (security_invoker = true) as
select date_trunc('month', coalesce(s.actual_settlement_date, s.current_projected_close_date))::date as month,
  sum(public.sale_gpc(s)) filter (where s.actual_settlement_date is not null or x.sale_id is null) as gci,
  sum(public.sale_gpc(s)) filter (where s.actual_settlement_date is not null) as closed_gci,
  sum(public.sale_gpc(s)) filter (where s.actual_settlement_date is null and x.sale_id is null) as pending_gci,
  coalesce(sum(public.sale_gpc(s)) filter (where s.actual_settlement_date is null and x.sale_id is not null), 0) as excluded_gci,
  count(*) filter (where s.actual_settlement_date is null and x.sale_id is not null) as excluded_sales,
  count(*) filter (where s.actual_settlement_date is not null or x.sale_id is null) as sales
from public.sales s
left join public.projection_exclusions x on x.sale_id = s.sale_id
where s.termination_date is null and coalesce(s.actual_settlement_date, s.current_projected_close_date) is not null
group by 1;
revoke all on public.gci_by_month from anon;
grant select on public.gci_by_month to authenticated;
notify pgrst, 'reload schema';
