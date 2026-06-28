# Vollo on Supabase (free tier, $0)

The Vollo backend runs entirely on the Supabase free tier — no separate server,
no paid resources:

| Concern | Old (Express on Render) | New (Supabase free) |
| --- | --- | --- |
| Data | Postgres + PostGIS | **Supabase Postgres + PostGIS** |
| API | Express (Node) web service | **Edge Function `api`** (Deno + Hono) |
| Background jobs | `node-cron` in the web process | **pg_cron + pg_net** sweeps |
| Auth | Custom HS256 JWT (bcrypt) | **Supabase Auth** (token validated in-function) |
| Secrets | env vars | private `app_secrets` table (RLS-sealed) |

Project ref: `pfophuqopwfupxjonsty` · region `us-east-1`.

## Why this is $0

- Postgres, PostGIS, Edge Functions, pg_cron and pg_net are all included in the
  free tier.
- The Edge Function connects to Postgres over the **direct connection**
  (`SUPABASE_DB_URL`, auto-injected), which bypasses RLS — so all access is
  funnelled through the function's own authorization and the public PostgREST/anon
  API stays sealed (every app table has RLS enabled with no policies).
- Auth is **Supabase Auth**: the client signs in with the JS SDK and sends the
  resulting access token as the bearer; the function validates it with the
  service-role client (`adminClient.auth.getUser`) and resolves it to the app
  profile via `users.auth_id`.
- The function is deployed with `verify_jwt = false` because it validates tokens
  itself and serves genuinely public routes (feed, resolve-email, courts reads).

## Layout

```
supabase/
  config.toml              # project id + functions.api.verify_jwt = false
  migrations/              # 001-005 (app) + 006 (secrets) + 007 (cron)
                           # + 008/009 (RLS seal + security-invoker views)
                           # + 010 (court source/osm dedup + user equipment)
                           # + 011 (court sectors: one facility = one court)
                           # + 012 (Supabase Auth: auth_id + signup trigger)
                           # + 013 (player colour) + 014 (scheduled matches)
  functions/api/           # the entire API, ported to Deno + Hono
    index.ts               # Hono app: every /api/* route, auth, error handling, sweep endpoint
    db.ts                  # postgres.js adapter (query/queryOne/withTransaction/pool)
    supabaseAdmin.ts       # service-role client: validate bearer tokens, delete auth users
    config.ts types.ts validation.ts errors.ts mappers.ts geo.ts
    overpass.ts            # OpenStreetMap discovery: names + groups pitches into sectors
    scoring.ts rating.ts streak.ts territory.ts analytics.ts
    achievements.ts notifications.ts geocoding.ts sweeps.ts
    deno.json              # import map (hono, postgres, zod, @supabase/supabase-js)
```

The HTTP contract is identical to the old Express API (same `/api/*` paths, JSON
shapes, and `{ error: { code, message } }` envelope), so the mobile client only
changed its base URL (`mobile/app.json` → `expo.extra.apiUrl`).

The Edge Function is reached at:

```
https://pfophuqopwfupxjonsty.supabase.co/functions/v1/api/<path>
```

A call to `…/functions/v1/api/feed` arrives inside the function as `/api/feed`,
matching the routes. So the mobile base URL is
`https://pfophuqopwfupxjonsty.supabase.co/functions/v1` and the client's existing
`/api` prefix completes the path.

### Auth (Supabase Auth)

Sign-up/sign-in happen client-side via the Supabase JS SDK; the function never
sees a password. The only auth route it serves is
`GET /api/auth/resolve-email?username=` (rate-limited), which lets the app turn a
typed username into the email Supabase Auth signs in with. Migration `012` adds
`users.auth_id`, drops `password_hash`, and installs an `AFTER INSERT ON
auth.users` trigger that provisions the profile row from the sign-up metadata
(`username`, `display_name`). **For sign-up to log a user in immediately, disable
email confirmation in the project's Auth settings** (otherwise there's no session
until the user confirms).

## Status: LIVE

The function is deployed and verified end-to-end (auth, match logging, feed,
leaderboard, Elo, streak, PostGIS territories, achievements, notifications,
kudos/comments/follows, search, and the pg_cron sweep path all pass):

```
https://pfophuqopwfupxjonsty.supabase.co/functions/v1/api/health  ->  {"status":"ok"}
```

## Court discovery, naming & sectors

`GET /api/courts/discover?min_lng&min_lat&max_lng&max_lat` populates the map at
$0 from OpenStreetMap (Overpass API, no key). `overpass.ts`:

1. **Names** each court from the named OSM feature that contains it (school,
   park, club, sports-centre — ways *and* multipolygon relations, via
   point-in-polygon, plus a ~90 m nearest-feature fallback). So a bare pitch
   becomes e.g. `North Creek High School Tennis Courts` instead of `Tennis Court`.
2. **Groups** co-located pitches into one facility ("sector"): a school's 6
   courts collapse to a single `courts` row with `court_count = 6`, keyed by
   `sector_key` (the container's OSM id, or the cluster's smallest member id for
   anonymous courts). Because matches reference that one row, the existing
   court-level leaderboard and PostGIS territory engine treat the **whole
   facility as one court for domination** — no engine changes needed.

Flags: `import=0` returns DB courts only (the client's instant first paint, no
Overpass call); `force=1` bypasses the per-viewport import cache (used by the
backfill). Overpass is only queried for viewports ≤ 0.35° per axis.

**Backfill** (re-import a region with one row per facility): delete the
regenerable rows (`DELETE FROM courts WHERE source='osm'` — they carry no
matches that can't be re-linked by location) and call `/courts/discover?…&import=1&force=1`
over a grid of ≤0.35° tiles. This drives the exact production path; ~3.4k real
pitches in Puget Sound + NYC fold into ~1.2k named facility rows.

## Deploy / update the function (canonical)

The clean, self-contained way to (re)deploy from the source in `functions/api/`:

```bash
# one-time auth (browser or token)
supabase login
# or: export SUPABASE_ACCESS_TOKEN=sbp_xxx

# from the repo root:
supabase functions deploy api --project-ref pfophuqopwfupxjonsty
# or: ./supabase/deploy.sh   (with SUPABASE_ACCESS_TOKEN set)
```

`verify_jwt = false` is taken from `config.toml`; no `--no-verify-jwt` needed.

### How the current live version was bootstrapped (and re-deployed without a token)

Deploys done without a CLI token use a bundle-and-load trick: the `functions/api/`
source is bundled into one ESM file (esbuild, deps kept as `npm:` specifiers),
hosted on a public gist, and imported by a one-line loader `index.ts`. The
Supabase deploy bundler fetches that URL and **inlines it at build time**, so the
deployed function is fully self-contained (it does NOT fetch the gist at runtime —
and the build sandbox only allows fetches from allowlisted hosts like
`gist.githubusercontent.com`, not arbitrary file hosts). The bundle contains no
secrets (the DB URL and JWT/sweep secrets load from env / the `app_secrets` table
at runtime, and the service-role key / DB URL are auto-injected env), so the gist
is safe to be public.

To reproduce the bundle: esbuild `index.ts` with `bundle:true, format:'esm'`,
mapping the six bare deps to their `npm:` specifiers as `external`. Running the
canonical CLI deploy above instead builds direct-from-source and makes the gist
irrelevant. (The import map now bundles `@supabase/supabase-js` for token
validation; `jose`/`bcryptjs` are gone with the old custom-JWT auth.)

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
