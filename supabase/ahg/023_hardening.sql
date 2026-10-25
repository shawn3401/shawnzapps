-- Security and performance check before switchover (Oct 25, 2026, Supabase's advisors). Safe to re-run.
-- 1. Nothing is callable without signing in. Postgres lets everyone (PUBLIC) run a new function, and
--    Supabase also grants the anon role; the internal jot functions (jot_insert and jot_write take a
--    table name) were callable that way. Now: no function for anon or PUBLIC; the internal ones only
--    for the service role and the database itself; signed-in users keep the ones the page and the
--    access rules use (each checks the role itself).
-- 2. Helper functions get a fixed search_path.
-- 3. sales gets its primary key (sale_id, unique in Access) and the busiest lookups get indexes.
set client_min_messages = warning;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname in ('app_users_guard', 'app_users_keep_admin', 'jot_address', 'jot_apply', 'jot_create_sale', 'jot_insert',
                     'jot_issue', 'jot_lead_candidates', 'jot_lead_values', 'jot_person', 'jot_sale_values', 'jot_write',
                     'jot_ingest', 'jot_after_refresh', 'fill_start_dates') then
      execute format('revoke execute on function %s from authenticated', f.sig);
    end if;
  end loop;
end $$;
-- functions created later: not runnable by anon or PUBLIC unless granted on purpose
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f'
             and p.proname in ('jot_num', 'jot_pct', 'jot_rate', 'norm_name', 'appt_status', 'jot_ts', 'jot_tidy', 'jot_fix_year',
                               'jot_client_name', 'sale_gpc', 'idaho_holidays', 'workday', 'dlr_count', 'dlr_data', 'jot_agent_counts') loop
    execute format('alter function %s set search_path = public, extensions', f.sig);
  end loop;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.sales'::regclass and contype = 'p') then
    alter table public.sales add primary key (sale_id);
  end if;
end $$;
create index if not exists sales_primary_sales_rep on public.sales (primary_sales_rep);
create index if not exists sales_client_name on public.sales (client_name);
create index if not exists sharedat_team_level_rep on public.sharedat_team_level (team_level_sales_rep);
create index if not exists sharedat_team_level_sale on public.sharedat_team_level (sales_id);
create index if not exists leads_sales_rep on public.leads (sales_rep);
create index if not exists lender_approvals_sale on public.lender_approvals (sale);

notify pgrst, 'reload schema';
