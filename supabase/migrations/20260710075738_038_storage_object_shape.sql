-- 038: constrain direct Storage writes to Vollo-owned object shapes.
--
-- Authenticated clients still own their folder, but can no longer create an
-- arbitrary-depth tree that makes bounded account deletion impossible. Legacy
-- stable avatar/cover keys and pre-idempotency match filenames remain valid.

DROP POLICY IF EXISTS "user-media owner insert" ON storage.objects;
CREATE POLICY "user-media owner insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'user-media'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND (
      name ~* ('^' || (SELECT auth.uid())::text || '/match/[A-Za-z0-9][A-Za-z0-9._-]{0,199}[.]jpg$')
      OR name ~* ('^' || (SELECT auth.uid())::text || '/profile/(avatar|cover)-[A-Za-z0-9][A-Za-z0-9._-]{0,199}[.]jpg$')
      OR name ~* ('^' || (SELECT auth.uid())::text || '/(avatar|cover)[.]jpg$')
    )
  );

DROP POLICY IF EXISTS "user-media owner update" ON storage.objects;
CREATE POLICY "user-media owner update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'user-media'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND (
      name ~* ('^' || (SELECT auth.uid())::text || '/match/[A-Za-z0-9][A-Za-z0-9._-]{0,199}[.]jpg$')
      OR name ~* ('^' || (SELECT auth.uid())::text || '/profile/(avatar|cover)-[A-Za-z0-9][A-Za-z0-9._-]{0,199}[.]jpg$')
      OR name ~* ('^' || (SELECT auth.uid())::text || '/(avatar|cover)[.]jpg$')
    )
  )
  WITH CHECK (
    bucket_id = 'user-media'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND (
      name ~* ('^' || (SELECT auth.uid())::text || '/match/[A-Za-z0-9][A-Za-z0-9._-]{0,199}[.]jpg$')
      OR name ~* ('^' || (SELECT auth.uid())::text || '/profile/(avatar|cover)-[A-Za-z0-9][A-Za-z0-9._-]{0,199}[.]jpg$')
      OR name ~* ('^' || (SELECT auth.uid())::text || '/(avatar|cover)[.]jpg$')
    )
  );
-- Migration version is normalized against the production Supabase ledger.
