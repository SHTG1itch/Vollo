# Vollo on Supabase (free tier, $0)

The Vollo backend runs entirely on the Supabase free tier — no separate server,
no paid resources:

| Concern | Old (Express on Render) | New (Supabase free) |
| --- | --- | --- |
| Data | Postgres + PostGIS | **Supabase Postgres + PostGIS** |
| API | Express (Node) web service | **Edge Function `api`** (Deno + Hono) |
| Background jobs | `node-cron` in the web process | **pg_cron + pg_net** sweeps |
| Auth | Custom HS256 JWT (bcrypt) | **Same custom JWT** (jose + bcryptjs) |
| Secrets | env vars | private `app_secrets` table (RLS-sealed) |

Project ref: `pfophuqopwfupxjonsty` · region `us-east-1`.

## Why this is $0

- Postgres, PostGIS, Edge Functions, pg_cron and pg_net are all included in the
  free tier.
- The Edge Function connects to Postgres over the **direct connection**
  (`SUPABASE_DB_URL`, auto-injected), which bypasses RLS — so all access is
  funnelled through the function's own JWT auth and the public PostgREST/anon
  API stays sealed (every app table has RLS enabled with no policies).
- The function is deployed with `verify_jwt = false` because it implements its
  own bearer-token auth and serves public routes (login/register/feed).

## Layout

```
supabase/
  config.toml              # project id + functions.api.verify_jwt = false
  migrations/              # full schema: 001-005 (app) + 006 (secrets) + 007 (cron)
  functions/api/           # the entire API, ported to Deno + Hono
    index.ts               # Hono app: every /api/* route, auth, error handling, sweep endpoint
    db.ts                  # postgres.js adapter (query/queryOne/withTransaction/pool)
    auth.ts                # HS256 sign/verify (jose) + bcrypt
    config.ts types.ts validation.ts errors.ts mappers.ts geo.ts
    scoring.ts rating.ts streak.ts territory.ts analytics.ts
    achievements.ts notifications.ts geocoding.ts sweeps.ts
    deno.json              # import map (hono, postgres, jose, bcryptjs, zod)
```

The HTTP contract is identical to the old Express API (same `/api/*` paths, JSON
shapes, and `{ error: { code, message } }` envelope), so the mobile client only
changed its base URL (`mobile/app.json` → `expo.extra.apiUrl`).

The Edge Function is reached at:

```
https://pfophuqopwfupxjonsty.supabase.co/functions/v1/api/<path>
```

A call to `…/functions/v1/api/auth/login` arrives inside the function as
`/api/auth/login`, matching the original routes. So the mobile base URL is
`https://pfophuqopwfupxjonsty.supabase.co/functions/v1` and the client's existing
`/api` prefix completes the path.

## Deploy / update the function

```bash
# one-time auth (browser or token)
supabase login
# or: export SUPABASE_ACCESS_TOKEN=sbp_xxx

# from the repo root:
supabase functions deploy api --project-ref pfophuqopwfupxjonsty
```

`verify_jwt = false` is taken from `config.toml`; no `--no-verify-jwt` needed.

## Migrations

Already applied to the live project. To reproduce on a fresh project:

```bash
supabase db push --project-ref <ref>
```

## Scheduled sweeps (pg_cron)

| Job | Schedule (UTC) | Action |
| --- | --- | --- |
| `vollo-streak-sweep` | daily 03:00 | recompute every user's streak (decay) |
| `vollo-territory-sweep` | every 6 h | recompute territories + achievements |

Both POST to `…/api/internal/sweep` via `pg_net`, authenticated with the shared
`internal_secret` from `app_secrets`. Inspect runs:

```sql
SELECT * FROM cron.job;
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
```
