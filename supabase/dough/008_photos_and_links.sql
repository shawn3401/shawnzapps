-- Dough app: photos on a bake, and links on a recipe (for example the icing recipe that goes with it). Safe to re-run.
-- Photos are shrunk in the browser to 1600px JPEG and stored in the public-read bucket `dough-photos`
-- at <user id>/<bake id>/<uuid>.jpg. Paths are unguessable and the bucket cannot be listed by others,
-- which is what lets a shared recipe show the author's photos without an account.

alter table public.dough_bakes add column if not exists photos jsonb not null default '[]'::jsonb;   -- ["<path>", ...]
alter table public.dough_types add column if not exists links  jsonb not null default '[]'::jsonb;   -- [{label, url}]

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dough-photos', 'dough-photos', true, 8388608, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists dough_photos_insert on storage.objects;
drop policy if exists dough_photos_select on storage.objects;
drop policy if exists dough_photos_delete on storage.objects;
create policy dough_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'dough-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy dough_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'dough-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy dough_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'dough-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- the share lookup now carries recipe links and bake photos too
create or replace function public.dough_shared(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'author', coalesce((select p.display_name from public.dough_profiles p where p.user_id = t.user_id), 'A Dough baker'),
    'own_id', case when t.user_id = (select auth.uid()) then t.id end,
    'recipe', jsonb_build_object('name', t.name, 'category', t.category, 'sizing', t.sizing, 'timing', t.timing,
                                 'ingredients', t.ingredients, 'steps', t.steps, 'notes', t.notes, 'links', t.links, 'tips', t.tips, 'defaults', t.defaults),
    'bakes', coalesce((
      select jsonb_agg(q.x) from (
        select jsonb_build_object('made_on', b.made_on, 'bake_on', b.bake_on, 'rating', b.rating, 'sizing', b.sizing, 'count', b.count,
                 'size_in', b.size_in, 'thickness', b.thickness, 'ball_g', b.ball_g, 'flour_g', b.flour_g, 'ferment', b.ferment,
                 'flour_name', b.flour_name, 'plan_notes', b.plan_notes, 'went_well', b.went_well, 'went_poorly', b.went_poorly,
                 'next_time', b.next_time, 'log', b.log, 'photos', b.photos) as x
        from public.dough_bakes b
        where b.type_id = t.id and b.user_id = t.user_id and b.reported_at is not null
        order by b.made_on desc, b.created_at desc limit 20) q), '[]'::jsonb))
  from public.dough_types t
  where p_token is not null and length(p_token) >= 16 and t.share_token = p_token and t.follows_token is null;
$$;
revoke all on function public.dough_shared(text) from public;
grant execute on function public.dough_shared(text) to anon, authenticated;
