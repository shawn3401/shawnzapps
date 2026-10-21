-- Jotform submissions (Opportunity Path jot, and later the sales jot). Safe to re-run.
-- Not copied from Access, so the switchover refresh never touches these tables.
-- Filled by Edge Function jot-sync (supabase/ahg/functions/jot-sync) every few minutes, and once
-- by ahg-tools/import/jot_backfill.py. Both call jot_ingest(), which keeps the latest answers on
-- jot_submissions and adds a jot_versions row only when the answers actually changed, so every
-- stage an agent saves is kept (a rescheduled appointment isn't lost when the date is overwritten).
set client_min_messages = warning;

create table if not exists public.jot_forms (
  form_id text primary key,
  name text not null,
  kind text not null check (kind in ('opportunity', 'sale')),
  active boolean not null default true,
  synced_through text,          -- newest created/updated time seen, in Jotform's own clock ("YYYY-MM-DD HH:MM:SS")
  last_sync_at timestamptz,
  last_sync_note text
);

create table if not exists public.jot_submissions (
  id text primary key,          -- Jotform submission id
  form_id text not null references public.jot_forms (form_id),
  jot_created_at text,          -- Jotform's clock
  jot_updated_at text,
  status text,
  answers jsonb not null,       -- {question id: answer}, empty answers dropped
  answers_md5 text not null,
  versions integer not null default 1,
  first_seen_at timestamptz not null default now(),
  changed_at timestamptz not null default now()
);
create index if not exists jot_submissions_form_changed on public.jot_submissions (form_id, changed_at desc);

create table if not exists public.jot_versions (
  id bigint generated always as identity primary key,
  submission_id text not null references public.jot_submissions (id) on delete cascade,
  jot_updated_at text,
  answers jsonb not null,
  answers_md5 text not null,
  seen_at timestamptz not null default now()
);
create index if not exists jot_versions_sub on public.jot_versions (submission_id, id);

-- The jot's question list, refreshed by jot-sync, so pages can show labels.
create table if not exists public.jot_questions (
  form_id text not null references public.jot_forms (form_id),
  qid text not null,
  label text,
  type text,
  qorder integer,
  primary key (form_id, qid)
);

-- Jot names (dropdowns use first names) to Access team members. Confirmed by Shawn Oct 21, 2026
-- ("Mike" is Mike Hicks; "Mike J" is MikeJ Johnston).
create table if not exists public.jot_people (
  jot_name text primary key,
  team_member_id integer not null
);

-- Upsert a batch of submissions as Jotform's API returns them (answers already slimmed to
-- {qid: answer}). Returns how many were new and how many changed.
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
    elsif old_h <> h then
      update jot_submissions set jot_updated_at = s ->> 'updated_at', status = s ->> 'status',
        answers = s -> 'answers', answers_md5 = h, versions = versions + 1, changed_at = now()
      where id = s ->> 'id';
      insert into jot_versions (submission_id, jot_updated_at, answers, answers_md5)
      values (s ->> 'id', coalesce(s ->> 'updated_at', s ->> 'created_at'), s -> 'answers', h);
      n_changed := n_changed + 1;
    else
      update jot_submissions set status = s ->> 'status', jot_updated_at = s ->> 'updated_at' where id = s ->> 'id';
    end if;
  end loop;
  return jsonb_build_object('new', n_new, 'changed', n_changed);
end $$;
revoke all on function public.jot_ingest(text, jsonb) from public, anon, authenticated;

-- Staff and admins can read; only the sync (service role) writes.
do $$
declare t text;
begin
  foreach t in array array['jot_forms', 'jot_submissions', 'jot_versions', 'jot_questions', 'jot_people'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('drop policy if exists "staff read" on public.%I', t);
    execute format('create policy "staff read" on public.%I for select to authenticated using (public.is_staff())', t);
  end loop;
end $$;

insert into public.jot_forms (form_id, name, kind) values ('210986480612155', 'Opportunity Path', 'opportunity')
on conflict (form_id) do nothing;

insert into public.jot_people (jot_name, team_member_id) values
  ('Aaron', 66), ('Anike', 130), ('Araceli', 185), ('Brett', 147), ('Byron', 191), ('Casey', 177),
  ('Chris M', 190), ('Dreyson', 176), ('Eric', 53), ('Eva', 135), ('Forrest', 108), ('Janell', 3),
  ('Jon', 126), ('Josh G', 169), ('Julio', 179), ('Katie', 170), ('Kelsie', 175), ('Kyle W', 150),
  ('Lani', 54), ('Lisa', 178), ('Liz', 55), ('Mike', 10), ('Mike J', 189), ('Nazha', 133),
  ('Nicole', 57), ('Riley', 95), ('Ryan M', 72), ('Sayer', 186), ('Shawn', 1), ('Sterling', 164),
  ('Steven V', 63), ('Stockton', 141), ('Suzanne', 183), ('Trevor', 138), ('Tyler', 188), ('Tyson', 171)
on conflict (jot_name) do update set team_member_id = excluded.team_member_id;

notify pgrst, 'reload schema';
