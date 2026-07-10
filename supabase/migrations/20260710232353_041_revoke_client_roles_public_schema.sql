-- Defense in depth for the Data API surface. The mobile app talks only to
-- Supabase Auth, Storage, and the edge function (which connects as the table
-- owner over SUPABASE_DB_URL), so the PostgREST `anon`/`authenticated` roles
-- have no legitimate use for anything in `public`. Migration 008 sealed app
-- tables with policy-less RLS, but the roles still held standing GRANTs, and
-- extension objects that cannot carry RLS (spatial_ref_sys, st_estimatedextent
-- and the rest of PostGIS's PUBLIC-executable catalog) remained reachable via
-- /rest/v1 with the publishable key. Revoking schema USAGE closes the whole
-- surface in one step; the explicit object revokes and default-privilege
-- changes keep it closed for objects created later.
REVOKE USAGE ON SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
