-- Migration 041 removed anon/authenticated's explicit grants, but the PUBLIC
-- pseudo-role still held USAGE on schema public (and supabase_admin-granted
-- object ACLs on PostGIS objects are not revocable by postgres). Revoking the
-- schema's PUBLIC grant closes the remaining path: without schema USAGE the
-- client roles cannot reach any object inside it, whatever its object ACL says.
-- postgres and service_role keep their explicit USAGE grants; superuser-backed
-- platform roles are unaffected.
REVOKE USAGE ON SCHEMA public FROM PUBLIC;
