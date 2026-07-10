\set ON_ERROR_STOP on

-- Supabase's schema-level linter also checks extension-owned routines. PostGIS
-- is intentionally installed in public for backwards compatibility, and some
-- of its legacy helper functions cannot be analyzed without runtime-only state.
-- Select first-party routines by catalog ownership so new extension functions
-- are excluded automatically while every Vollo PL/pgSQL routine stays covered.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS plpgsql_check WITH SCHEMA extensions;

CREATE TEMP TABLE vollo_function_lint_errors AS
SELECT
  issue.functionid::text AS function_name,
  issue.lineno,
  issue.statement,
  issue.sqlstate,
  issue.message,
  issue.detail,
  issue.hint,
  issue.query,
  issue.context
FROM pg_catalog.pg_proc AS routine
JOIN pg_catalog.pg_namespace AS namespace
  ON namespace.oid = routine.pronamespace
JOIN pg_catalog.pg_language AS routine_language
  ON routine_language.oid = routine.prolang
LEFT JOIN pg_catalog.pg_trigger AS attached_trigger
  ON attached_trigger.tgfoid = routine.oid
CROSS JOIN LATERAL extensions.plpgsql_check_function_tb(
  routine.oid,
  COALESCE(attached_trigger.tgrelid, 0::oid),
  fatal_errors => false,
  oldtable => attached_trigger.tgoldtable,
  newtable => attached_trigger.tgnewtable
) AS issue
WHERE namespace.nspname = 'public'
  AND routine_language.lanname = 'plpgsql'
  AND lower(issue.level) = 'error'
  AND (
    routine.prorettype <> 'pg_catalog.trigger'::regtype
    OR attached_trigger.tgfoid IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_depend AS dependency
    WHERE dependency.classid = 'pg_catalog.pg_proc'::regclass
      AND dependency.objid = routine.oid
      AND dependency.deptype = 'e'
  );

TABLE vollo_function_lint_errors;

DO $lint$
DECLARE
  error_count integer;
BEGIN
  SELECT count(*) INTO error_count FROM vollo_function_lint_errors;

  IF error_count > 0 THEN
    RAISE EXCEPTION 'Vollo PL/pgSQL lint failed with % error(s)', error_count;
  END IF;
END
$lint$;
