-- ════════════════════════════════════════════════════════════════════════
-- Vollo — Storage bucket for user-uploaded media (avatars, covers, match photos)
--
-- One PUBLIC bucket, foldered by the uploader's auth uid. The mobile client
-- uploads directly to Storage with its OWN Supabase session (the `authenticated`
-- role it already holds); the RLS below confines every write to "<auth.uid()>/…",
-- so a user can only touch their own folder. Reads are public (avatars/cover/
-- match photos render in the feed and on profiles). The edge function is
-- unchanged: it stays the only writer of users.avatar_url / cover_url /
-- matches.photo_url, persisting the public URL the client passes up.
--
-- One bucket, not three: storage.objects RLS is global and each policy filters
-- by bucket_id, so every extra bucket is another copy of these four policies.
-- Avatars, covers and match photos share the same ownership rule (first path
-- segment = uploader's auth uid) and the same public-read posture, so they live
-- together and are told apart by the key prefix:
--     <auth_uid>/avatar.jpg
--     <auth_uid>/cover.jpg
--     <auth_uid>/match/<match_id>-<ts>.jpg
-- ════════════════════════════════════════════════════════════════════════

-- 1. The bucket. public = true → objects are served from the unauthenticated
--    /storage/v1/object/public/... CDN path that getPublicUrl() builds. The
--    picker normalises crops to JPEG; png/webp are allowed for completeness.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'user-media',
  'user-media',
  true,
  8388608,                                     -- 8 MB ceiling; cropped photos are tens–hundreds of KB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- RLS is already enabled on storage.objects by Supabase; we only add policies.
-- storage.foldername(name) returns the path segments BEFORE the file name as
-- text[]; [1] is the top folder. We require it to equal the caller's auth uid,
-- so writes are confined to "<uid>/…". (select auth.uid()) is wrapped per
-- Supabase's RLS perf guidance so the planner caches it as an initplan.

-- 2. Public read — anyone (anon or authenticated) can SELECT, matching the
--    public CDN path the app links to.
drop policy if exists "user-media public read" on storage.objects;
create policy "user-media public read"
  on storage.objects for select
  to public
  using (bucket_id = 'user-media');

-- 3. INSERT — an authenticated user may upload only into their own folder.
drop policy if exists "user-media owner insert" on storage.objects;
create policy "user-media owner insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'user-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- 4. UPDATE — needed for upsert (overwriting the stable avatar.jpg / cover.jpg
--    key). USING gates the existing row, WITH CHECK the new one; both the owner.
drop policy if exists "user-media owner update" on storage.objects;
create policy "user-media owner update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'user-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'user-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- 5. DELETE — owner can remove their own objects (replacing/clearing media).
drop policy if exists "user-media owner delete" on storage.objects;
create policy "user-media owner delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'user-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
