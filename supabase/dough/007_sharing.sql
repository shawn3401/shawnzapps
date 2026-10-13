-- Dough app: share a recipe by link. Safe to re-run.
-- Author: dough_types.share_token (null = not shared). Anyone with the link can read the recipe through
-- dough_shared(token), which returns the CURRENT recipe, the author's display name, and their reported bakes.
-- Receiver, signed in, picks one:
--   follow: their own dough_types row with follows_token set. Read-only mirror, refreshed from dough_shared on load.
--   copy:   their own ordinary row with copied_from set to the author's name. No link back.
-- If the author stops sharing or deletes the recipe, a followed row becomes an ordinary copy (the page does this).

create table if not exists public.dough_profiles (
  user_id      uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  updated_at   timestamptz not null default now()
);
alter table public.dough_profiles enable row level security;
drop policy if exists dough_profiles_select on public.dough_profiles;
drop policy if exists dough_profiles_insert on public.dough_profiles;
drop policy if exists dough_profiles_update on public.dough_profiles;
create policy dough_profiles_select on public.dough_profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy dough_profiles_insert on public.dough_profiles for insert to authenticated with check ((select auth.uid()) = user_id);
create policy dough_profiles_update on public.dough_profiles for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
revoke all on public.dough_profiles from anon;
grant select, insert, update on public.dough_profiles to authenticated;

alter table public.dough_types
  add column if not exists share_token   text unique,
  add column if not exists follows_token text,
  add column if not exists author_name   text,
  add column if not exists copied_from   text;
create index if not exists dough_types_follows on public.dough_types (follows_token);

create or replace function public.dough_shared(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'author', coalesce((select p.display_name from public.dough_profiles p where p.user_id = t.user_id), 'A Dough baker'),
    'own_id', case when t.user_id = (select auth.uid()) then t.id end,
    'recipe', jsonb_build_object('name', t.name, 'category', t.category, 'sizing', t.sizing, 'timing', t.timing,
                                 'ingredients', t.ingredients, 'steps', t.steps, 'notes', t.notes, 'tips', t.tips, 'defaults', t.defaults),
    'bakes', coalesce((
      select jsonb_agg(q.x) from (
        select jsonb_build_object('made_on', b.made_on, 'bake_on', b.bake_on, 'rating', b.rating, 'sizing', b.sizing, 'count', b.count,
                 'size_in', b.size_in, 'thickness', b.thickness, 'ball_g', b.ball_g, 'flour_g', b.flour_g, 'ferment', b.ferment,
                 'flour_name', b.flour_name, 'plan_notes', b.plan_notes, 'went_well', b.went_well, 'went_poorly', b.went_poorly,
                 'next_time', b.next_time, 'log', b.log) as x
        from public.dough_bakes b
        where b.type_id = t.id and b.user_id = t.user_id and b.reported_at is not null
        order by b.made_on desc, b.created_at desc limit 20) q), '[]'::jsonb))
  from public.dough_types t
  where p_token is not null and length(p_token) >= 16 and t.share_token = p_token and t.follows_token is null;
$$;
revoke all on function public.dough_shared(text) from public;
grant execute on function public.dough_shared(text) to anon, authenticated;
