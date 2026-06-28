-- Seal the public PostgREST/anon REST API: enable RLS (with NO policies) on every
-- app table. The Edge Function connects via the direct SUPABASE_DB_URL as the
-- table-owner role (postgres), which bypasses RLS — so the API keeps full access
-- while the anon/publishable key can read/write nothing. All access is gated by
-- the function's own JWT auth. (app_secrets already has RLS enabled in 006.)
ALTER TABLE public.users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_stats   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kudos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_streaks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.territories   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_ratings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.achievements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_tokens   ENABLE ROW LEVEL SECURITY;
