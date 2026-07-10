-- Make the two helper views run with the caller's privileges (not the definer's),
-- so PostgREST/anon access respects RLS instead of bypassing it. The Edge Function
-- queries them as the owner role (postgres), which still bypasses RLS — so the API
-- is unaffected while anon/authenticated get nothing.
ALTER VIEW public.court_leaderboard SET (security_invoker = on);
ALTER VIEW public.match_feed        SET (security_invoker = on);

-- Defense in depth: the public REST roles have no business reading these views.
REVOKE ALL ON public.court_leaderboard FROM anon, authenticated;
REVOKE ALL ON public.match_feed        FROM anon, authenticated;

-- Pin a stable search_path on the trigger function (linter hardening).
ALTER FUNCTION public.set_updated_at() SET search_path = pg_catalog, public;
-- Migration version is normalized against the production Supabase ledger.
