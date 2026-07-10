# Vollo on Supabase (free tier, $0)

The Vollo backend runs entirely on the Supabase free tier — no separate server,
no paid resources:

| Concern | Old (Express on Render) | New (Supabase free) |
| --- | --- | --- |
| Data | Postgres + PostGIS | **Supabase Postgres + PostGIS** |
| API | Express (Node) web service | **Edge Function `api`** (Deno + Hono) |
| Background jobs | `node-cron` in the web process | **pg_cron + pg_net** sweeps |
| Auth | Custom HS256 JWT (bcrypt) | **Supabase Auth** (token validated in-function) |
| Secrets | env vars | Edge secrets + private `app_secrets` table (RLS-sealed) |

Project ref: `pfophuqopwfupxjonsty` · region `us-east-1`.

## Why this is $0

- Postgres, PostGIS, Edge Functions, pg_cron and pg_net are all included in the
  free tier.
- The Edge Function uses one bounded connection per isolate through the
  **transaction pooler** (`DATABASE_POOL_URL`, port 6543, prepared statements
  disabled). It falls back to `SUPABASE_DB_URL` for local/bootstrap use. Database
  access bypasses RLS, so authorization stays in the function while the public
  PostgREST/anon API remains sealed.
- Auth is **Supabase Auth**: the client signs in with the JS SDK and sends the
  resulting access token as the bearer; the function validates it with the
  service-role client (`adminClient.auth.getUser`) and resolves it to the app
  profile via `users.auth_id`.
- The function is deployed with `verify_jwt = false` because it validates tokens
  itself and serves genuinely public routes such as health, login, feed, and
  court reads.

## Layout

```
supabase/
  config.toml              # project id + functions.api.verify_jwt = false
  migrations/              # production-timestamped schema/history through 042
  tests/                   # pgTAP production invariants
  functions/api/           # the entire API, ported to Deno + Hono
    index.ts               # Hono app: every /api/* route, auth, error handling, sweep endpoint
    db.ts                  # postgres.js adapter (query/queryOne/withTransaction/pool)
    supabaseAdmin.ts       # service-role client: validate bearer tokens, delete auth users
    config.ts types.ts validation.ts errors.ts mappers.ts geo.ts
    overpass.ts            # OpenStreetMap discovery: names + groups pitches into sectors
    scoring.ts rating.ts streak.ts territory.ts analytics.ts
    achievements.ts notifications.ts geocoding.ts sweeps.ts mediaCleanup.ts
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

Sign-up happens client-side via the Supabase JS SDK (the user supplies their own
email); **sign-in is proxied server-side** so the client never needs — and never
sees — anyone's email:

- `POST /api/auth/login` — body `{ identifier, password }`. The function resolves
  a username (or email) to its email internally, completes the password grant with
  the anon-key client, and returns the session tokens; the client installs them
  with `supabase.auth.setSession`. "No such account" and "wrong password" fail
  identically (no enumeration); an unconfirmed email returns `403 email_not_confirmed`.
- `GET /api/auth/username-available?username=` — sign-up "handle taken" check;
  discloses only availability, never an email.

Both are rate-limited per IP. Migration `012` adds `users.auth_id`, drops
`password_hash`, and installs a trigger on `auth.users` that provisions the profile
row from the sign-up metadata (`username`, `display_name`) **once the email is
confirmed** — so unconfirmed bot sign-ups never create rows or squat usernames.
**Keep email confirmation enabled** in the project's Auth settings (the default)
to make that protection effective. Because Vollo has no website, the **Site URL is
the app deep link `vollo://`** (Authentication → URL Configuration, mirrored in
`config.toml` `[auth]`) so the confirmation/recovery links open the app instead of
dead-ending on `http://localhost:3000`. The token is verified server-side before
that redirect, so confirmation succeeds even if the deep link doesn't resolve.

**Google / Apple sign-in** (native ID-token flow) is wired through the same
machinery: the app calls `supabase.auth.signInWithIdToken`, the resulting session
validates through the same `adminClient.auth.getUser` path, and migration `015`
extends the provisioning trigger to derive a clean handle, display name and avatar
from the provider's metadata (OAuth identities carry no sign-up form). It's
additive — email sign-up is unchanged. **Google is configured and live** (provider
enabled, button on via `googleAuthEnabled: true`; provisioning verified end-to-end
against the project); Apple stays dormant until its paid program is set up.
**Setup walk-through: [`OAUTH_SETUP.md`](./OAUTH_SETUP.md)** (and the
`[auth.external.*]` blocks in `config.toml`).

## Production endpoint

The deployed health endpoint is:

```
https://pfophuqopwfupxjonsty.supabase.co/functions/v1/api/health  ->  {"status":"ok"}
```

Treat the repository commit—not a previously deployed bundle—as canonical. Apply
its migrations and deploy its function together, then run the smoke/load checks
from the root README before calling that release current.

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

For serverless database traffic, provision either the complete transaction-mode
`DATABASE_POOL_URL`, or only the non-secret `DATABASE_POOL_HOST` shown by the
project's shared-pooler connection details. With the host-only option, Vollo
derives the port-6543 URL inside the Edge isolate from Supabase's injected
`SUPABASE_DB_URL`; the database password is never copied into source control or
CLI output. Invalid/non-Supabase pooler hosts fail closed during startup.

## Migrations

To apply the committed history to a linked project:

```bash
supabase db push --project-ref <ref>
```

## Scheduled sweeps (pg_cron)

| Job | Schedule (UTC) | Action |
| --- | --- | --- |
| `vollo-streak-sweep` | every 15 min | claim/recompute one bounded user batch |
| `vollo-territory-sweep` | every 30 min | claim/recompute one bounded user batch |
| `vollo-media-cleanup` | every 5 min | delete one bounded batch of queued Storage objects |
| `vollo-login-attempt-retention` | hourly at minute 7 | delete one bounded batch older than 24 hours |
| `vollo-notification-retention` | hourly at minute 17 | delete one bounded batch past the read/unread retention window |
| `vollo-geocode-cache-cleanup` | Sundays at 04:15 | remove expired geocoder and court-discovery cache rows |

The three Edge-backed sweeps POST to `…/api/internal/sweep` via `pg_net`,
authenticated with the shared `internal_secret` from `app_secrets`. The
destination comes from the environment-specific Vault secret named
`project_url`; without it, local/CI Edge jobs are deliberate no-ops. The three
database-local cleanup jobs run bounded SQL directly in PostgreSQL. Inspect
runs:

```sql
SELECT * FROM cron.job;
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
```

## Database verification

GitHub Actions starts a clean local Supabase stack, applies all migrations, runs
`supabase test db`, and lints first-party public PL/pgSQL functions at error
level. Extension-owned routines are identified from PostgreSQL's catalogs and
excluded because PostGIS ships legacy helpers that require runtime-only state.
Locally, the equivalent commands require Docker, `psql`, and the pinned
Supabase CLI:

```bash
supabase db start
supabase test db
PGPASSWORD=postgres psql --host 127.0.0.1 --port 54322 --username postgres \
  --dbname postgres --file supabase/lint/public_app_functions.sql
supabase stop --no-backup
```
