-- Prevent profile-media upserts from failing after the first upload.
--
-- Migration 025 intentionally removed the broad SELECT policy so clients could
-- not enumerate every object in the public bucket. Supabase Storage upsert also
-- needs SELECT on the existing object, though, in addition to UPDATE. Restore a
-- narrowly-scoped owner read: authenticated users can see only rows in their own
-- top-level folder. Public object URLs remain readable through the public CDN,
-- while anonymous/cross-user Storage listing stays denied.

DROP POLICY IF EXISTS "user-media owner select" ON storage.objects;
CREATE POLICY "user-media owner select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'user-media'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
-- Migration version is normalized against the production Supabase ledger.
