-- Automatic leads and sales from jots (Shawn, Oct 21, 2026). Safe to re-run.
-- jot_ingest() calls jot_apply() for every new or changed submission. Rules:
--  * Opportunity Path: one lead per side ("Buyer and Seller" makes two). A jot submitted after the
--    form's auto_from creates its lead(s); an older jot that gets edited is matched to the lead the
--    success team typed into Access (same type, close name, received within 4 days) and only fills
--    that lead's blank fields. A jot whose "lead received" date is over a year old is probably a
--    returning client: no lead is created, it goes on the Needs attention list.
--  * Contract Cover Sheet: one sale. The lead is the single clear match (same type, same agent,
--    close name, received in the last 2 years); none or several -> Needs attention, no sale yet.
--  * Later edits update only fields nobody changed by hand: jot_links.written remembers what the jot
--    last wrote, and a field whose value differs from that was edited in AHG Tools and is left alone.
--  * Close dates and title company aren't in the contract jot; those sales show on Needs attention
--    until they're filled in (view jot_attention).
-- The Access refresh (ahg-tools/import/access_import.py) replaces leads and sales, so it calls
-- jot_after_refresh(), which forgets the links and starts creating again from the copy's time.
set client_min_messages = warning;
set search_path = public, extensions;

alter table public.jot_forms add column if not exists auto_from text;   -- Jotform clock

create table if not exists public.jot_links (
  submission_id text not null references public.jot_submissions (id) on delete cascade,
  side text not null,                 -- 'Buyer', 'Seller', or 'Sale'
  kind text not null check (kind in ('lead', 'sale')),
  record_id integer not null,
  created boolean not null,           -- true: the jot created it; false: matched to an existing record
  written jsonb not null default '{}',
  linked_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (submission_id, side)
);

create table if not exists public.jot_issues (
  id bigint generated always as identity primary key,
  submission_id text not null references public.jot_submissions (id) on delete cascade,
  side text not null,
  kind text not null,                 -- returning_client, pick_lead, missing_fields, check_received, unknown_value
  message text not null,
  candidates jsonb,                   -- [{id, name, type, received, owner}] for pick_lead / returning_client
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution text
);
create unique index if not exists jot_issues_open on public.jot_issues (submission_id, side, kind) where resolved_at is null;

do $$
declare t text;
begin
  foreach t in array array['jot_links', 'jot_issues'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists "staff read" on public.%I', t);
    execute format('create policy "staff read" on public.%I for select to authenticated using ((select public.is_staff()))', t);
  end loop;
end $$;

-- Insert a row from jot values, naming only the columns given, so table defaults fill the rest.
create or replace function public.jot_insert(p_table text, p_key text, p_vals jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare cols text; new_id integer;
begin
  select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(p_vals) k
  where exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = p_table and c.column_name = k);
  execute format('insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1) returning %I', p_table, cols, cols, p_table, p_key)
    into new_id using p_vals;
  return new_id;
end $$;

create or replace function public.jot_issue(p_sub text, p_side text, p_kind text, p_msg text, p_cand jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into jot_issues (submission_id, side, kind, message, candidates) values (p_sub, p_side, p_kind, p_msg, p_cand)
  on conflict (submission_id, side, kind) where resolved_at is null do update set message = excluded.message, candidates = excluded.candidates
$$;

-- Write jot values onto a record: only columns that are blank, or still hold what the jot wrote last.
create or replace function public.jot_write(p_table text, p_key text, p_id integer, p_vals jsonb, p_written jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cur jsonb; k text; v jsonb; sets text[] := '{}'; out jsonb := p_written;
begin
  execute format('select to_jsonb(t) from %I t where %I = $1', p_table, p_key) into cur using p_id;
  if cur is null then return null; end if;
  for k, v in select * from jsonb_each(p_vals) loop
    if not cur ? k then continue; end if;
    if (cur -> k) = 'null'::jsonb or (p_written ? k and (cur -> k) = (p_written -> k)) or
       (p_written ? k and left(cur ->> k, 10) = left(p_written ->> k, 10) and k like '%date%') then
      if (cur -> k) is distinct from v then
        sets := sets || format('%I = (jsonb_populate_record(null::%I, $1)).%I', k, p_table, k);
      end if;
      out := out || jsonb_build_object(k, v);
    end if;
  end loop;
  if array_length(sets, 1) > 0 then
    execute format('update %I set %s where %I = $2', p_table, array_to_string(sets, ', '), p_key) using p_vals, p_id;
  end if;
  return out;
end $$;

-- Leads that could be this client: for matching an old jot and for "returning client" choices.
create or replace function public.jot_lead_candidates(p_name text, p_type text, p_owner integer, p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(x order by x ->> 'score' desc), '[]') from (
    select jsonb_build_object('id', l.id, 'name', l.lead_name, 'type', l.lead_type, 'received', l.lead_received_date::date,
      'owner', t.team_member_name, 'score', round(similarity(lower(l.lead_name), lower(p_name))::numeric, 2)) x
    from leads l left join team_members t on t.id = l.sales_rep
    where similarity(lower(l.lead_name), lower(p_name)) >= 0.35
      and (p_type is null or l.lead_type = p_type) and (p_owner is null or l.sales_rep = p_owner)
      and (p_from is null or l.lead_received_date >= p_from) and (p_to is null or l.lead_received_date <= p_to)
    order by similarity(lower(l.lead_name), lower(p_name)) desc limit 5) y
$$;

create or replace function public.jot_apply(p_sub text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  s record; f record; sd text; v jsonb; lk record; new_id integer; cand jsonb; submitted date; recv date;
  is_new boolean; lead_id integer; lender_id integer;
begin
  select * into s from jot_submissions where id = p_sub;
  select * into f from jot_forms where form_id = s.form_id;
  if s is null or f.auto_from is null then return; end if;
  submitted := left(s.jot_created_at, 10)::date;
  is_new := s.jot_created_at >= f.auto_from;

  if f.kind = 'opportunity' then
    foreach sd in array case when s.answers ->> '203' = 'Buyer and Seller' then array['Buyer', 'Seller']
                               when s.answers ->> '203' in ('Buyer', 'Seller') then array[s.answers ->> '203'] else array[]::text[] end loop
      v := jot_lead_values(s.answers, sd, submitted);
      select * into lk from jot_links where submission_id = p_sub and jot_links.side = sd;
      if lk is not null then
        update jot_links set written = coalesce(jot_write('leads', 'id', lk.record_id, v - 'received_as_typed', lk.written), written), updated_at = now()
        where submission_id = p_sub and jot_links.side = sd;
        continue;
      end if;
      recv := (v ->> 'lead_received_date')::date;
      if not is_new then
        -- an older jot: link it to the lead the success team typed in, if there's one clear match
        cand := jot_lead_candidates(v ->> 'lead_name', sd, null, recv - 4, recv + 4);
        if jsonb_array_length(cand) = 1 or (jsonb_array_length(cand) > 1 and (cand -> 0 ->> 'score')::numeric - (cand -> 1 ->> 'score')::numeric >= 0.15) then
          insert into jot_links (submission_id, side, kind, record_id, created) values (p_sub, sd, 'lead', (cand -> 0 ->> 'id')::int, false);
          update jot_links set written = coalesce(jot_write('leads', 'id', (cand -> 0 ->> 'id')::int, v - 'received_as_typed', '{}'), '{}')
          where submission_id = p_sub and jot_links.side = sd;
        end if;
        continue;
      end if;
      if recv is not null and recv < submitted - 365 then
        perform jot_issue(p_sub, sd, 'returning_client',
          format('The lead received date is %s, over a year before this jot. This may be a returning client with a lead already in AHG Tools. Pick their lead, or create a new one.', to_char(recv, 'FMMM/FMDD/YYYY')),
          jot_lead_candidates(v ->> 'lead_name', sd, null, null, null));
        continue;
      end if;
      -- the success team may have typed this lead in already (sometimes before the jot): same type,
      -- same lead owner, a close name, received within 4 days -> link to it instead of a duplicate
      cand := jot_lead_candidates(v ->> 'lead_name', sd, (v ->> 'sales_rep')::int, recv - 4, recv + 4);
      if jsonb_array_length(cand) > 0 and (cand -> 0 ->> 'score')::numeric >= 0.5
         and not exists (select 1 from jot_links where kind = 'lead' and record_id = (cand -> 0 ->> 'id')::int) then
        insert into jot_links (submission_id, side, kind, record_id, created) values (p_sub, sd, 'lead', (cand -> 0 ->> 'id')::int, false);
        update jot_links set written = coalesce(jot_write('leads', 'id', (cand -> 0 ->> 'id')::int, v - 'received_as_typed', '{}'), '{}')
        where submission_id = p_sub and jot_links.side = sd;
        continue;
      end if;
      new_id := jot_insert('leads', 'id', v - 'received_as_typed');
      insert into jot_links (submission_id, side, kind, record_id, created, written) values (p_sub, sd, 'lead', new_id, true, v - 'received_as_typed');
      if v ? 'received_as_typed' then
        perform jot_issue(p_sub, sd, 'check_received', format('The jot says the lead came in %s. That looked like a typo for %s, so the lead uses %s. Please check.',
          to_char((v ->> 'received_as_typed')::date, 'FMMM/FMDD/YYYY'), to_char(recv, 'FMMM/FMDD/YYYY'), to_char(recv, 'FMMM/FMDD/YYYY')));
      elsif recv > submitted then
        perform jot_issue(p_sub, sd, 'check_received', format('The lead received date (%s) is after the jot was submitted. Please check it.', to_char(recv, 'FMMM/FMDD/YYYY')));
      end if;
      if not (v ? 'lead_source') or not (v ? 'team_member_credit') or not (v ? 'trigger') then
        perform jot_issue(p_sub, sd, 'unknown_value', 'The lead was created, but the jot didn''t give a lead source, team member credit, or appointment trigger AHG Tools recognizes. Please fill in the blanks.');
      end if;
    end loop;

  elsif f.kind = 'sale' then
    v := jot_sale_values(s.answers);
    select * into lk from jot_links where submission_id = p_sub and jot_links.side = 'Sale';
    if lk is not null then
      update jot_links set written = coalesce(jot_write('sales', 'sale_id', lk.record_id, v, lk.written), written), updated_at = now()
      where submission_id = p_sub and jot_links.side = 'Sale';
      return;
    end if;
    if not is_new then return; end if;
    -- already typed into Access (same type, close address, contract within 10 days of the jot) -> link
    select x.sale_id into new_id from sales x
    where x.sale_type = v ->> 'sale_type' and similarity(lower(x.address), lower(v ->> 'address')) >= 0.5
      and x.contract_date between submitted - 10 and submitted + 3
      and not exists (select 1 from jot_links k where k.kind = 'sale' and k.record_id = x.sale_id)
    order by similarity(lower(x.address), lower(v ->> 'address')) desc limit 1;
    if new_id is not null then
      insert into jot_links (submission_id, side, kind, record_id, created) values (p_sub, 'Sale', 'sale', new_id, false);
      update jot_links set written = coalesce(jot_write('sales', 'sale_id', new_id, v, '{}'), '{}') where submission_id = p_sub and side = 'Sale';
      return;
    end if;
    -- the lead: one clear match by type, agent, and name, received in the last two years
    cand := jot_lead_candidates(s.answers ->> '7', case v ->> 'sale_type' when 'Listing' then 'Seller' else 'Buyer' end,
                                (v ->> 'primary_sales_rep')::int, submitted - 730, submitted);
    if jsonb_array_length(cand) = 1 or (jsonb_array_length(cand) > 1 and (cand -> 0 ->> 'score')::numeric - (cand -> 1 ->> 'score')::numeric >= 0.15) then
      lead_id := (cand -> 0 ->> 'id')::int;
      perform jot_create_sale(p_sub, lead_id);
    else
      perform jot_issue(p_sub, 'Sale', 'pick_lead',
        case when jsonb_array_length(cand) = 0 then 'No lead matches this contract (same agent, buyer or seller, similar name, last two years). Pick the lead to create the sale.'
             else 'More than one lead could be this client. Pick the right one to create the sale.' end,
        case when jsonb_array_length(cand) = 0 then jot_lead_candidates(s.answers ->> '7', null, null, submitted - 730, submitted) else cand end);
    end if;
  end if;
end $$;

-- Create the sale for a contract jot once its lead is known (automatically, or when someone picks it).
create or replace function public.jot_create_sale(p_sub text, p_lead integer) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare s record; v jsonb; new_id integer; lender_id integer;
begin
  select * into s from jot_submissions where id = p_sub;
  v := jot_sale_values(s.answers) || jsonb_build_object('client_name', p_lead);
  -- jots from before the Contract Date question (added Oct 21, 2026): use the jot's date and flag it
  if not v ? 'contract_date' then
    v := v || jsonb_build_object('contract_date', jot_ts(s.answers -> '3')::date);
    perform jot_issue(p_sub, 'Sale', 'check_contract_date', 'This contract jot has no contract date, so the sale uses the jot date (' ||
      to_char(jot_ts(s.answers -> '3'), 'FMMM/FMDD/YYYY') || '). Please check it against the contract.');
  end if;
  new_id := jot_insert('sales', 'sale_id', v);
  insert into jot_links (submission_id, side, kind, record_id, created, written) values (p_sub, 'Sale', 'sale', new_id, true, v - 'client_name');
  -- the lender, when it clearly matches one on the Lenders list ("Cash" counts)
  select id into lender_id from lenders where similarity(lower(lender_name), lower(s.answers ->> '15')) >= 0.5
    order by similarity(lower(lender_name), lower(s.answers ->> '15')) desc limit 1;
  if lender_id is not null then insert into lender_approvals (lender, sale) values (lender_id, new_id); end if;
  update jot_issues set resolved_at = now(), resolution = 'sale created' where submission_id = p_sub and side = 'Sale' and kind = 'pick_lead' and resolved_at is null;
  return new_id;
end $$;

-- Hook into the sync: every new or changed submission is applied right after it's stored.
create or replace function public.jot_ingest(p_form text, p_subs jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s jsonb; h text; old_h text; n_new int := 0; n_changed int := 0;
begin
  for s in select * from jsonb_array_elements(p_subs) loop
    h := md5((s -> 'answers')::text);
    select answers_md5 into old_h from jot_submissions where id = s ->> 'id';
    if old_h is null then
      insert into jot_submissions (id, form_id, jot_created_at, jot_updated_at, status, answers, answers_md5)
      values (s ->> 'id', p_form, s ->> 'created_at', s ->> 'updated_at', s ->> 'status', s -> 'answers', h);
      insert into jot_versions (submission_id, jot_updated_at, answers, answers_md5)
      values (s ->> 'id', coalesce(s ->> 'updated_at', s ->> 'created_at'), s -> 'answers', h);
      n_new := n_new + 1;
      perform jot_apply(s ->> 'id');
    elsif old_h <> h then
      update jot_submissions set jot_updated_at = s ->> 'updated_at', status = s ->> 'status',
        answers = s -> 'answers', answers_md5 = h, versions = versions + 1, changed_at = now()
      where id = s ->> 'id';
      insert into jot_versions (submission_id, jot_updated_at, answers, answers_md5)
      values (s ->> 'id', coalesce(s ->> 'updated_at', s ->> 'created_at'), s -> 'answers', h);
      n_changed := n_changed + 1;
      perform jot_apply(s ->> 'id');
    else
      update jot_submissions set status = s ->> 'status', jot_updated_at = s ->> 'updated_at' where id = s ->> 'id';
    end if;
  end loop;
  return jsonb_build_object('new', n_new, 'changed', n_changed);
end $$;
revoke all on function public.jot_ingest(text, jsonb) from public, anon, authenticated;

-- After a refresh from Access: leads and sales were replaced, so the links point at nothing (or the
-- wrong rows). Forget them and the issues, and create from jots submitted after the copy was taken.
create or replace function public.jot_after_refresh(p_copy_time text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  delete from jot_links; delete from jot_issues;
  update jot_forms set auto_from = p_copy_time;
  for r in select s.id from jot_submissions s join jot_forms f using (form_id)
           where s.jot_created_at >= p_copy_time or coalesce(s.jot_updated_at, '') >= p_copy_time
           order by f.kind = 'sale', s.jot_created_at loop   -- leads before sales, oldest first
    perform jot_apply(r.id); n := n + 1;
  end loop;
  return jsonb_build_object('applied', n);
end $$;
revoke all on function public.jot_after_refresh(text) from public, anon, authenticated;

-- Staff actions from the Needs attention list.
create or replace function public.jot_resolve(p_issue bigint, p_action text, p_lead integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare i record; v jsonb; s record; new_id integer; who text := lower(auth.jwt() ->> 'email');
begin
  if not is_staff() then raise exception 'Only staff and admins can do this.'; end if;
  select * into i from jot_issues where id = p_issue and resolved_at is null;
  if i is null then raise exception 'That item was already handled.'; end if;
  select * into s from jot_submissions where id = i.submission_id;
  if i.kind = 'pick_lead' and p_action = 'lead' then
    new_id := jot_create_sale(i.submission_id, p_lead);
    update jot_issues set resolved_by = who, resolution = 'sale created for lead ' || p_lead where id = p_issue;
    return jsonb_build_object('sale', new_id);
  elsif i.kind = 'returning_client' and p_action = 'lead' then
    v := jot_lead_values(s.answers, i.side, left(s.jot_created_at, 10)::date) - 'received_as_typed';
    insert into jot_links (submission_id, side, kind, record_id, created) values (i.submission_id, i.side, 'lead', p_lead, false);
    update jot_links set written = coalesce(jot_write('leads', 'id', p_lead, v - 'lead_received_date', '{}'), '{}') where submission_id = i.submission_id and side = i.side;
    update jot_issues set resolved_at = now(), resolved_by = who, resolution = 'linked to lead ' || p_lead where id = p_issue;
    return jsonb_build_object('lead', p_lead);
  elsif i.kind = 'returning_client' and p_action = 'new' then
    v := jot_lead_values(s.answers, i.side, left(s.jot_created_at, 10)::date) - 'received_as_typed';
    new_id := jot_insert('leads', 'id', v);
    insert into jot_links (submission_id, side, kind, record_id, created, written) values (i.submission_id, i.side, 'lead', new_id, true, v);
    update jot_issues set resolved_at = now(), resolved_by = who, resolution = 'new lead ' || new_id where id = p_issue;
    return jsonb_build_object('lead', new_id);
  elsif p_action = 'done' then
    update jot_issues set resolved_at = now(), resolved_by = who, resolution = 'marked done' where id = p_issue;
    return '{}';
  end if;
  raise exception 'Unknown action.';
end $$;
revoke all on function public.jot_resolve(bigint, text, integer) from public, anon;
grant execute on function public.jot_resolve(bigint, text, integer) to authenticated;

-- Everything on the Needs attention list: open issues, plus sales a contract jot created that still
-- lack what the jot can't give (close dates, title company).
drop view if exists public.jot_attention;
create view public.jot_attention with (security_invoker = true) as
select i.id as issue_id, i.submission_id, s.form_id, i.side, i.kind, i.message, i.candidates, i.created_at,
  -- question numbers mean different things on the two jots
  case when s.form_id = '210986480612155' then concat_ws(' & ', nullif(trim(s.answers ->> '36'), ''), nullif(trim(s.answers ->> '37'), '')) else s.answers ->> '7' end as client,
  case when s.form_id = '210986480612155' then s.answers ->> '70' else s.answers ->> '4' end as agent, null::integer as sale_id
from jot_issues i join jot_submissions s on s.id = i.submission_id
where i.resolved_at is null
union all
select null, k.submission_id, s.form_id, 'Sale', 'missing_fields',
  'Sale created from the contract jot. Add ' || concat_ws(', ',
    case when x.orig_projected_close_date is null then 'original close date' end,
    case when x.current_projected_close_date is null then 'current close date' end,
    case when x.title_company is null then 'title company' end) || ', which the jot doesn''t ask for.',
  null, k.linked_at, s.answers ->> '7', s.answers ->> '4', x.sale_id
from jot_links k join sales x on x.sale_id = k.record_id join jot_submissions s on s.id = k.submission_id
where k.kind = 'sale' and (x.orig_projected_close_date is null or x.current_projected_close_date is null or x.title_company is null);
revoke all on public.jot_attention from anon;
grant select on public.jot_attention to authenticated;

notify pgrst, 'reload schema';
