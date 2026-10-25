-- Audit list (Shawn, Oct 25, 2026): rules flag records that need a person to look at them; the success
-- team reviews the list daily and clears each item by fixing the record (the item closes by itself on
-- the next check) or by marking it OK as it is (with an optional note). Built to grow: a rule is a row
-- in audit_rules with a query that returns the flagged records; Shawn and Claude add rules over time.
-- audit_scan() runs every 5 minutes (pg_cron) and when the Audit page opens. Safe to re-run.
set client_min_messages = warning;

create table if not exists public.audit_rules (
  key text primary key,
  title text not null,               -- shown as the group heading
  description text not null,         -- what to do about it
  record_kind text not null check (record_kind in ('lead', 'sale')),
  query text not null,               -- returns (record id, detail text), any column names; $1 = since
  since date not null,               -- only records from this date on (received or contract date)
  active boolean not null default true,
  sort integer not null default 100
);

create table if not exists public.audit_items (
  id bigint generated always as identity primary key,
  rule_key text not null references public.audit_rules (key) on delete cascade,
  record_id integer not null,
  detail text,
  status text not null default 'open' check (status in ('open', 'ok', 'fixed')),
  found_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  note text,
  unique (rule_key, record_id)
);

do $$
declare t text;
begin
  foreach t in array array['audit_rules', 'audit_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists "staff read" on public.%I', t);
    execute format('create policy "staff read" on public.%I for select to authenticated using ((select public.is_staff()))', t);
  end loop;
end $$;
grant update (active) on public.audit_rules to authenticated;
drop policy if exists "admins switch" on public.audit_rules;
create policy "admins switch" on public.audit_rules for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- The rules. Lead source "Other" (id 15) and a commission rate under 3% (not referrals or flat fees).
insert into public.audit_rules (key, title, description, record_kind, query, since, sort) values
('lead_source_other', 'Lead source is "Other"',
 'Pick the real lead source (Sphere, Past Client, ...). Mark it OK if Other is right.', 'lead',
 $q$select id, coalesce('Source detail: ' || nullif(trim(lead_source_detail), ''), 'No source detail')
    from leads where lead_source = 15 and lead_received_date >= $1$q$, '2026-10-20', 10),
('commission_under_3', 'Commission rate under 3%',
 'Check the rate against the contract. Mark it OK if it''s right.', 'sale',
 $q$select sale_id, 'Rate ' || round(coalesce(projected_commission_percent, 0)::numeric * 100, 2) || '%'
    from sales where sale_type <> 'Referral' and not coalesce(commissionis_flat_amount, false)
      and coalesce(projected_commission_percent, 0) < 0.03 and termination_date is null and contract_date >= $1$q$, '2026-10-20', 20)
on conflict (key) do update set title = excluded.title, description = excluded.description, record_kind = excluded.record_kind, query = excluded.query, sort = excluded.sort;

-- Run every active rule: new finds open; open items no longer found are fixed; a fixed item found
-- again reopens; items marked OK stay OK.
create or replace function public.audit_scan() returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; f record; seen int[]; n_new int := 0; n_fixed int := 0; n int;
begin
  if not (public.is_staff() or coalesce(auth.role(), '') = 'service_role' or current_user in ('postgres', 'supabase_admin')) then
    raise exception 'Not on the team list.';
  end if;
  for r in select * from audit_rules where active loop
   begin   -- one broken rule doesn't stop the others
    seen := '{}';
    for f in execute format('select * from (%s) q(record_id, detail)', r.query) using r.since loop
      seen := seen || f.record_id;
      insert into audit_items (rule_key, record_id, detail) values (r.key, f.record_id, f.detail)
      on conflict (rule_key, record_id) do update set detail = excluded.detail,
        status = case when audit_items.status = 'fixed' then 'open' else audit_items.status end,
        resolved_at = case when audit_items.status = 'fixed' then null else audit_items.resolved_at end,
        resolved_by = case when audit_items.status = 'fixed' then null else audit_items.resolved_by end
      where audit_items.status <> 'ok' or audit_items.detail is distinct from excluded.detail;
      get diagnostics n = row_count; n_new := n_new + n;
    end loop;
    update audit_items set status = 'fixed', resolved_at = now(), resolved_by = 'fixed in the record'
    where rule_key = r.key and status = 'open' and not (record_id = any (seen));
    get diagnostics n = row_count; n_fixed := n_fixed + n;
   exception when others then
    raise warning 'audit rule % failed: %', r.key, sqlerrm;
   end;
  end loop;
  return jsonb_build_object('touched', n_new, 'fixed', n_fixed);
end $$;

create or replace function public.audit_mark(p_id bigint, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Only staff and admins can do this.'; end if;
  if p_status not in ('ok', 'open') then raise exception 'Unknown status.'; end if;
  update audit_items set status = p_status,
    resolved_at = case when p_status = 'ok' then now() end,
    resolved_by = case when p_status = 'ok' then lower(auth.jwt() ->> 'email') end,
    note = case when p_status = 'ok' then nullif(trim(p_note), '') else note end
  where id = p_id;
end $$;

revoke all on function public.audit_scan() from public, anon;
revoke all on function public.audit_mark(bigint, text, text) from public, anon;
grant execute on function public.audit_scan() to authenticated, service_role;
grant execute on function public.audit_mark(bigint, text, text) to authenticated;

select cron.unschedule('audit-scan') where exists (select 1 from cron.job where jobname = 'audit-scan');
select cron.schedule('audit-scan', '*/5 * * * *', 'select public.audit_scan()');

select public.audit_scan();
notify pgrst, 'reload schema';
