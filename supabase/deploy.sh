#!/usr/bin/env bash
# Deploy the Vollo API Edge Function to Supabase (free tier, $0).
#
# The validated function source lives in supabase/functions/api/. Deploying it
# requires a Supabase access token (the only step that can't be automated from
# here). Create one at https://supabase.com/dashboard/account/tokens
#
# Usage (from the repo root):
#   SUPABASE_ACCESS_TOKEN=sbp_xxx ./supabase/deploy.sh
#
# verify_jwt=false is taken from supabase/config.toml (the function does its own
# bearer-token auth and serves public routes).
set -euo pipefail

REF="pfophuqopwfupxjonsty"

if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "error: set SUPABASE_ACCESS_TOKEN (sbp_...) first." >&2
  echo "  token: https://supabase.com/dashboard/account/tokens" >&2
  exit 1
fi

npx -y supabase@2.101.0 functions deploy api --project-ref "$REF"

echo
echo "Deployed. Smoke test:"
echo "  curl https://$REF.supabase.co/functions/v1/api/health"
