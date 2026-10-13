-- Your Turn: pick a restaurant together. Tables for the ShawnZapps project, prefixed yourturn_.
-- Facts about a place are shared by everyone; ratings and history are personal and shared only
-- with people you have linked accounts with. Safe to re-run.

-- ---- profiles: the name other people see, and a saved home spot ------------------------------
create table if not exists public.yourturn_profiles (
  user_id      uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  home_lat     double precision,
  home_lng     double precision,
  home_label   text,
  updated_at   timestamptz not null default now()
);
alter table public.yourturn_profiles enable row level security;
drop policy if exists yourturn_profiles_own on public.yourturn_profiles;
create policy yourturn_profiles_own on public.yourturn_profiles for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on public.yourturn_profiles from anon, authenticated;
grant select, insert, update on public.yourturn_profiles to authenticated;

-- ---- people I eat with ------------------------------------------------------------------------
-- A row is a guest (just a name), an invite waiting (invite_email set), or a linked account
-- (linked_user_id set). Only yourturn_accept() can set linked_user_id, so linking takes both sides.
create table if not exists public.yourturn_people (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 40),
  invite_email   text,
  linked_user_id uuid references auth.users(id) on delete set null,
  last_used_at   timestamptz,
  created_at     timestamptz not null default now(),
  unique (owner_id, linked_user_id)
);
create index if not exists yourturn_people_owner on public.yourturn_people (owner_id);
create index if not exists yourturn_people_invite on public.yourturn_people (lower(invite_email)) where linked_user_id is null;
alter table public.yourturn_people enable row level security;
drop policy if exists yourturn_people_own on public.yourturn_people;
create policy yourturn_people_own on public.yourturn_people for all to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
revoke all on public.yourturn_people from anon, authenticated;
grant select, delete on public.yourturn_people to authenticated;
grant insert (name, invite_email) on public.yourturn_people to authenticated;
grant update (name, invite_email, last_used_at) on public.yourturn_people to authenticated;

-- Is this account linked with me?
create or replace function public.yourturn_linked(u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.yourturn_people p
                 where p.owner_id = (select auth.uid()) and p.linked_user_id = u);
$$;

-- Am I linked with anyone in this list? (who may see a visit)
create or replace function public.yourturn_sees(ids uuid[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.yourturn_people p
                 where p.owner_id = (select auth.uid()) and p.linked_user_id = any(ids));
$$;

-- Is everyone in this list me or linked with me? (who I may put on a visit)
create or replace function public.yourturn_party_ok(ids uuid[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select ids <@ (array(select p.linked_user_id from public.yourturn_people p
                       where p.owner_id = (select auth.uid()) and p.linked_user_id is not null)
                 || (select auth.uid()));
$$;

-- Invites waiting for me (sent to the email I signed up with).
create or replace function public.yourturn_invites() returns table (id uuid, from_name text)
language sql stable security definer set search_path = '' as $$
  select p.id, coalesce(pr.display_name, 'Someone')
  from public.yourturn_people p
  left join public.yourturn_profiles pr on pr.user_id = p.owner_id
  where p.linked_user_id is null
    and p.owner_id <> (select auth.uid())
    and lower(p.invite_email) = lower((select u.email from auth.users u where u.id = (select auth.uid())));
$$;

-- Accept an invite: link their row to me and add them to my list.
create or replace function public.yourturn_accept(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := (select auth.uid());
  v_owner uuid;
  v_name text;
begin
  update public.yourturn_people p set linked_user_id = v_me
  where p.id = p_id and p.linked_user_id is null and p.owner_id <> v_me
    and lower(p.invite_email) = lower((select u.email from auth.users u where u.id = v_me))
    and not exists (select 1 from public.yourturn_people x where x.owner_id = p.owner_id and x.linked_user_id = v_me)
  returning p.owner_id into v_owner;
  if v_owner is null then raise exception 'That invite is no longer there.'; end if;
  select coalesce(pr.display_name, 'Friend') into v_name from public.yourturn_profiles pr where pr.user_id = v_owner;
  insert into public.yourturn_people (owner_id, name, linked_user_id)
  values (v_me, coalesce(v_name, 'Friend'), v_owner)
  on conflict (owner_id, linked_user_id) do nothing;
end $$;

-- Decline an invite.
create or replace function public.yourturn_decline(p_id uuid) returns void
language sql security definer set search_path = '' as $$
  update public.yourturn_people p set invite_email = null
  where p.id = p_id and p.linked_user_id is null
    and lower(p.invite_email) = lower((select u.email from auth.users u where u.id = (select auth.uid())));
$$;

-- Removing a linked person unlinks the other side too (their row becomes a guest).
create or replace function public.yourturn_people_unlink() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.linked_user_id is not null then
    update public.yourturn_people set linked_user_id = null, invite_email = null
    where owner_id = old.linked_user_id and linked_user_id = old.owner_id;
  end if;
  return old;
end $$;
drop trigger if exists yourturn_people_unlink on public.yourturn_people;
create trigger yourturn_people_unlink after delete on public.yourturn_people
  for each row execute function public.yourturn_people_unlink();

revoke all on function public.yourturn_linked(uuid), public.yourturn_sees(uuid[]), public.yourturn_party_ok(uuid[]),
  public.yourturn_invites(), public.yourturn_accept(uuid), public.yourturn_decline(uuid), public.yourturn_people_unlink()
  from public, anon;
revoke all on function public.yourturn_people_unlink() from authenticated;   -- trigger only
grant execute on function public.yourturn_linked(uuid), public.yourturn_sees(uuid[]), public.yourturn_party_ok(uuid[]),
  public.yourturn_invites(), public.yourturn_accept(uuid), public.yourturn_decline(uuid) to authenticated;

-- ---- places: one row per restaurant anyone has touched, shared by everyone --------------------
-- Only places someone rated, visited, or corrected are saved; searches are live and not stored.
-- name, address and location are a cache of Google's listing (refreshed_at); the rest is ours.
create table if not exists public.yourturn_places (
  place_id     text primary key,                 -- Google place id
  name         text not null,
  address      text,
  lat          double precision,
  lng          double precision,
  maps_url     text,
  genre        text,                             -- GENRES key in the page
  style        text check (style in ('fast_food','fast_casual','sit_down','fine')),
  minutes      int check (minutes between 5 and 240),      -- typical time in and out
  waits        text check (waits in ('rarely','peak','usually')),
  reservable   boolean,
  refreshed_at timestamptz not null default now(),
  edited_by    uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);
alter table public.yourturn_places enable row level security;
drop policy if exists yourturn_places_read on public.yourturn_places;
create policy yourturn_places_read on public.yourturn_places for select to authenticated using (true);
drop policy if exists yourturn_places_add on public.yourturn_places;
create policy yourturn_places_add on public.yourturn_places for insert to authenticated with check ((select auth.uid()) is not null);
drop policy if exists yourturn_places_fix on public.yourturn_places;
create policy yourturn_places_fix on public.yourturn_places for update to authenticated
  using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);
revoke all on public.yourturn_places from anon, authenticated;
grant select, insert, update on public.yourturn_places to authenticated;

-- ---- ratings: mine, readable by people linked with me -----------------------------------------
create table if not exists public.yourturn_ratings (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  place_id    text not null references public.yourturn_places(place_id) on delete cascade,
  rating      smallint check (rating between 1 and 5),
  never_again boolean not null default false,
  want_to_try boolean not null default false,
  rest_days   int check (rest_days between 0 and 365),   -- days before suggesting it again; null = the app's default
  notes       text,
  updated_at  timestamptz not null default now(),
  primary key (user_id, place_id)
);
alter table public.yourturn_ratings enable row level security;
drop policy if exists yourturn_ratings_read on public.yourturn_ratings;
create policy yourturn_ratings_read on public.yourturn_ratings for select to authenticated
  using ((select auth.uid()) = user_id or public.yourturn_linked(user_id));
drop policy if exists yourturn_ratings_add on public.yourturn_ratings;
create policy yourturn_ratings_add on public.yourturn_ratings for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists yourturn_ratings_fix on public.yourturn_ratings;
create policy yourturn_ratings_fix on public.yourturn_ratings for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists yourturn_ratings_del on public.yourturn_ratings;
create policy yourturn_ratings_del on public.yourturn_ratings for delete to authenticated using ((select auth.uid()) = user_id);
revoke all on public.yourturn_ratings from anon, authenticated;
grant select, insert, update, delete on public.yourturn_ratings to authenticated;

-- ---- visits: where we went, who was there, whose turn it was ----------------------------------
create table if not exists public.yourturn_visits (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  place_id    text not null references public.yourturn_places(place_id),
  visited_on  date not null,
  party       jsonb not null default '[]'::jsonb,   -- [{key, name}]; key is a user id or "g:name" for a guest
  user_ids    uuid[] not null,                      -- the accounts at the table
  group_key   text not null,                        -- the sorted party keys; turns are tracked per group
  picker_key  text,
  picker_name text,
  created_at  timestamptz not null default now()
);
create index if not exists yourturn_visits_users on public.yourturn_visits using gin (user_ids);
create index if not exists yourturn_visits_place on public.yourturn_visits (place_id);
alter table public.yourturn_visits enable row level security;
drop policy if exists yourturn_visits_read on public.yourturn_visits;
create policy yourturn_visits_read on public.yourturn_visits for select to authenticated
  using ((select auth.uid()) = any(user_ids) or public.yourturn_sees(user_ids));
drop policy if exists yourturn_visits_add on public.yourturn_visits;
create policy yourturn_visits_add on public.yourturn_visits for insert to authenticated
  with check ((select auth.uid()) = created_by and (select auth.uid()) = any(user_ids) and public.yourturn_party_ok(user_ids));
drop policy if exists yourturn_visits_fix on public.yourturn_visits;
create policy yourturn_visits_fix on public.yourturn_visits for update to authenticated
  using ((select auth.uid()) = created_by)
  with check ((select auth.uid()) = created_by and (select auth.uid()) = any(user_ids) and public.yourturn_party_ok(user_ids));
drop policy if exists yourturn_visits_del on public.yourturn_visits;
create policy yourturn_visits_del on public.yourturn_visits for delete to authenticated using ((select auth.uid()) = created_by);
revoke all on public.yourturn_visits from anon, authenticated;
grant select, insert, update, delete on public.yourturn_visits to authenticated;

-- ---- usage: one row per search, for the Google call caps (Edge Function, service role only) ----
create table if not exists public.yourturn_usage (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  kind       text not null,
  calls      int not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists yourturn_usage_user_time on public.yourturn_usage (user_id, created_at desc);
create index if not exists yourturn_usage_time on public.yourturn_usage (created_at);
alter table public.yourturn_usage enable row level security;   -- no policies: service role only
revoke all on public.yourturn_usage from anon, authenticated;
