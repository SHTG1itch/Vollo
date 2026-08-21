<div align="center">

# 🎾 Vollo

### Strava for tennis — match analytics + geospatial territorial domination

Log matches, track multi-dimensional performance by surface, and **claim real-world
courts to project colored territory polygons across the map.** Built end-to-end on
free / open-source tooling for a **$0.00 infrastructure runway.**

</div>

---

## Download for Android

[**Download Vollo 0.1.0 for Android (versionCode 11)**](https://github.com/SHTG1itch/Vollo/releases/download/v0.1.0-android.11/Vollo-0.1.0-android-v11.apk)

- Requires Android 7.0 (API 24) or newer.
- Package: `app.vollo.mobile`
- SHA-256: `9BE52E886335B76B5F131D6046FE1A44CCD75A2678D245A7F0E9977794ACA40F`
- The APK is signed and hosted as a GitHub Release asset. Android may ask you
  to allow installs from your browser or file manager because this release is
  distributed directly rather than through Google Play.

Verify the file before installing:

```text
9BE52E886335B76B5F131D6046FE1A44CCD75A2678D245A7F0E9977794ACA40F  Vollo-0.1.0-android-v11.apk
```

See the [Privacy Policy](PRIVACY.md), [Terms of Use](TERMS.md), and
[Security Policy](SECURITY.md) before using or reporting an issue.

---

## What is Vollo?

Vollo treats every match as a discrete, richly-structured event (not a background GPS
stream). Each match feeds three systems:

1. **A social feed** of "Match Cards" with optimistic tennis-ball **Kudos**, comments and follows.
2. **Multi-dimensional analytics** — career stats partitioned by surface, a full stat
   matrix (serve %, winners/errors per stroke, rally-length distribution), per-surface
   **Vollo Rating** (Bayesian/Glicko-style), and a rolling **streak heat index**.
3. **The Geospatial Domination Engine** — win matches at courts to top their 30-day
   leaderboard; control ≥3 courts within 10 km and PostGIS draws a neon-green
   **concave-hull territory** whose vertices sit on the courts you actually hold.
   Lose your grip and the polygon contracts, mutates, or shatters — with push
   notifications when a rival cuts off your district or starts a **Turf War**.
   Matches against a Vollo opponent only count once a registered opposing player
   **verifies** them, so domination and Elo stay honest.

---

## Tech stack (100% free / open source)

| Layer | Choice | Why |
|------|--------|-----|
| Mobile | **Expo (React Native) + TypeScript** | One codebase → iOS & Android; EAS free cloud builds |
| State | **Zustand** | Tiny, minimal re-renders |
| Maps | **react-native-maps (iOS) / keyless Leaflet WebView (Android) + OSM raster tiles** | No commercial map licensing, no Google Maps API key |
| Courts | **OpenStreetMap Overpass API** | Imports real-world tennis courts into the map at $0 (no key) |
| Lists | **@shopify/flash-list** | High-performance feed rendering |
| API | **Supabase Edge Function (Deno + Hono + TypeScript)** | Single free function fronts all data access |
| Auth | **Supabase Auth** (+ native Google / Apple sign-in) | Sessions, refresh tokens, email confirmation |
| Database | **Supabase PostgreSQL + PostGIS** | Native spatial geometry + `ST_ConcaveHull` territories |
| Storage | **Supabase Storage** (`user-media`) | Profile/cover/match photos |
| Geocoding | **Nominatim (OSM)** / Geoapify free tier | Address → coordinates at no cost |
| Push | **Expo Push** → APNs + FCM | Free relay |

---

## Repo layout

```
Vollo/
├── mobile/                   # Expo app
│   └── src/
│       ├── api/              # typed fetch client (base URL from app.json extra)
│       ├── store/            # Zustand: auth (Supabase session bridge), feed, notifications
│       ├── components/       # MatchCard, KudosButton, ScoreInput, Toast, icons, charts…
│       ├── screens/          # Feed, Map, LogMatch, MatchDetail, Profile/analytics…
│       ├── lib/              # supabase client, oauth, haptics, image upload
│       └── navigation/       # tabs + root stack + deep links (vollo://)
└── supabase/
    ├── functions/api/        # the entire backend: Hono router, scoring, streak,
    │                         # rating, territory (concave hull), analytics, sweeps
    └── migrations/           # SQL schema (PostGIS, views, triggers, RLS)
```

The API runs as **one Supabase Edge Function** (`supabase/functions/api`), reached at
`https://<project>.supabase.co/functions/v1/api/*`. It connects to Postgres with the
service role (all client data access is funnelled through it; the public REST API
stays sealed) and validates Supabase Auth bearer tokens per request.

---

## Quickstart

### Mobile app

```bash
cd mobile
npm install
npx expo start
```

Open in **Expo Go** (scan the QR) or `i` / `a` for a simulator/emulator. The app
points at the production Supabase project via `app.json → extra.apiUrl`; override
with `EXPO_PUBLIC_API_URL` to target a different deployment.

> **Android map note:** Android renders a keyless Leaflet-in-WebView OSM map
> (react-native-maps would crash without a Google Maps API key); iOS uses
> react-native-maps on Apple Maps. Don't add a Google key or MapLibre — the
> current setup is deliberate and Expo Go-safe.

### Backend (Supabase)

- **Migrations** live in `supabase/migrations` (applied via the Supabase MCP/CLI).
- **Database runtime:** set the Edge secret `DATABASE_POOL_URL` to the project’s
  transaction-pooler connection string (port 6543) for production traffic. The
  function falls back to Supabase’s built-in `SUPABASE_DB_URL` for local/initial
  setup, and uses one connection per Edge isolate with prepared statements off.
- **Per-environment cron endpoint:** before or after migration `033`, store that
  environment's project base URL in Vault. Clean local/CI databases deliberately
  leave this absent, so their cron jobs cannot send traffic to a deployed project:

  ```sql
  select vault.create_secret(
    'https://<20-character-project-ref>.supabase.co',
    'project_url',
    'Vollo maintenance Edge Function base URL'
  );
  ```

  The scheduled statements accept only an HTTPS `*.supabase.co` project URL and
  become safe no-ops until it is provisioned.
- **Deploy** the edge function: bundle `supabase/functions/api` and deploy as the
  `api` function with `verify_jwt` disabled (the function does its own Supabase
  token validation, and `/auth/login` + `/auth/username-available` must be
  reachable pre-auth).
- OAuth provider setup is documented in [`supabase/OAUTH_SETUP.md`](supabase/OAUTH_SETUP.md).

---

## How the systems work

### Match scoring
`score_array` like `[[6,4],[2,6],[7,6]]` is analyzed into sets/games won-lost and a
result. A deciding match-tiebreak (e.g. `[10,8]`) counts as one game-equivalent.
The same team score model covers both formats: singles is 1 vs 1; doubles stores
the logger plus a partner against two opponents. Existing and omitted-format rows
remain singles.

```
MatchScore = (gamesWon − gamesLost) × StreakModifier
```

### Temporal heat index (streaks)
Activity is bucketed into rolling 7-day windows. The streak is the run of consecutive
windows with ≥1 match; the modifier scales up `+0.1` per maintained week, capped at
`×2.0`. A bounded sweep runs every 15 minutes and decays modifiers soon after a
window lapses without attempting to process the entire user base in one function.

### Match verification (competitive integrity)
A match logged against a **registered Vollo opponent** starts `pending` and counts for
**nothing** — not rating, streak, court leaderboard or territory — until an opposing
player **confirms** it (registered opponents get a push to Confirm/Dispute). In doubles,
either opposing player can resolve the request; the first response wins atomically.
A disputed match is `rejected` and never counts; a match whose opposing team is entirely
off-app is `auto` and counts immediately. A registered partner does not verify their own
team's result.
The court leaderboard view, streak, analytics and achievements all read only
`auto`/`verified` matches, and the confirm transition is status-guarded so a double-tap
can't apply effects twice. Doubles ratings compare the logger against the opposing
team's average current rating; singles keeps the original one-opponent calculation.

### Singles and doubles scheduling
Scheduled matches use the same format and team slots as logged results. Every registered
participant can see or cancel the schedule, either registered opposing player can accept
or decline it, and any registered participant can log the result from their own side.
When an opponent logs, the app rotates the scheduled teams automatically so “your games
first” and partner/opponent labels remain correct.

### Court leaderboards
Per court, over a trailing **30-day window**, players are ranked by `Σ MatchScore`
(verified matches only). Rank #1 is the **Court Controller**; ranks 1–2 "control" a
court for territory purposes. When a challenger climbs to within ~70 % of the
controller's score at a court inside their territory, the controller gets a
**⚔️ Turf War Initiated** alert.

### The Domination Engine (concave hull)
On every counting match (plus a bounded 30-minute maintenance sweep) the engine,
for each affected player:

1. pulls **controlled courts** (rank ≤ 2 in the 30-day window),
2. **clusters** them by the 10 km radius (single-linkage),
3. for each cluster of **≥ 3 courts**, runs a PostGIS concave hull so the polygon's
   vertices land on the courts the player holds (convex-hull / 75 m-buffer fallback for
   degenerate cases):

   ```sql
   SELECT ST_AsGeoJSON(ST_ConcaveHull(ST_Collect(court_geom), 0.7, false))
   FROM courts WHERE id = ANY(:controlled_court_ids);
   ```
4. **diffs** against existing territories → fires `territory_gained` / `territory_changed`
   / `territory_lost` notifications, and `court_taken` / `court_dethroned` when control
   flips. The polygon is served as GeoJSON and rendered as a semi-transparent
   brand-green polygon overlay.

### Vollo Rating (Bayesian)
Each `(player, surface)` skill is a Gaussian posterior `θ ~ N(μ, σ²)`, where μ is
the rating and σ the **rating deviation** (model uncertainty). Every counting
match is a Bayesian update layer — Glicko's closed form, where the posterior
precision is the prior precision **plus** the match's information precision, and
the posterior mean is the precision-weighted blend of prior and evidence:

```
1/σ'²  =  1/σ²  +  M · q² · g(σ_opp)² · E·(1−E)          (precision adds)
μ'     =  μ  +  (1/σ'²) · q · g(σ_opp) · (S − E) · M     (mean update)
```

`M` is the game-margin multiplier (a blowout is stronger evidence), `S` the
outcome and `E` the model's expected score. Uncertainty shrinks with evidence, so
a provisional player's rating moves fast and a seasoned one barely budges. Ratings
are a pure function of history, recomputed by replaying a player's counting
matches from the prior (`recomputeUserRatings`), which makes deletion exact with
no fragile delta-reversal. Only the logging player's posterior updates (the
verified-match gate keeps that honest).

---

## Feature highlights

- **Real-world courts on the map** — the map and court pickers pull tennis courts
  straight from OpenStreetMap (Overpass API) for the current viewport and serve
  them to every user — all at $0. Each court is **named** from the OSM feature
  that contains it (`North Creek High School Tennis Courts`, not `Tennis Court`).
- **Court sectors** — a facility's courts (a school with 6, a park with 12) are
  grouped into **one** court row (`court_count`), so the whole venue is a single
  unit for domination and a single marker on the map.
- **Drop-a-pin court adding** — can't find a court? Pan the map so the 🎾 sits on
  it, name it, pick a surface, set how many courts the venue has, and it's saved
  as a shared court everyone sees (reverse-geocoding fills the city best-effort).
- **Match verification** — a match tagged against a registered opponent only counts
  once they confirm it (either opponent can respond in doubles), keeping Elo and turf honest.
- **Turf Wars** — when a rival closes in on a court you control inside your
  territory, you get a "⚔️ Turf War Initiated" alert so control is a constant fight.
- **Challenge a player** — a ⚔️ Challenge button on any profile (or on a domination
  zone's card) proposes a schedulable match; the opponent gets a challenge push.
- **Share to story + sticker** — a Strava-style share sheet produces an exact
  1080×1920 story image in Photo or Court mode, plus a transparent PNG Sticker
  containing the match metrics for compositing over another photo. It can open
  the native share sheet or copy the rendered image to the clipboard.
- **Photos everywhere** — profile, cover and proof-of-play match photos via
  Supabase Storage.
- **Native Google / Apple sign-in** — ID-token flow into Supabase Auth with Apple
  nonce binding; native refresh tokens live in the device Keychain/Keystore and
  username login is proxied server-side so emails never leave the backend.
- **Fast, crash-free map** — courts paint instantly from the DB while new ones
  import from OSM in the background; native overlays are capped, unmount during
  gestures, and remount on the idle frame.
- **Clubs** — open groups anyone can create and join, each with a shared match
  feed and a 30-day member leaderboard; the last admin leaving promotes the
  longest-standing member, and an emptied club dissolves.
- **Goals** — weekly/monthly targets (matches, wins, or hours on court) with
  live progress bars on your profile; progress is computed from counted matches
  so verification flips and deletes stay exact.
- **Trophy case** — all-time personal records: longest win streak, peak rating,
  biggest win, most aces, longest match, busiest month, comeback wins.
- **Training log** — a month calendar of your matches (win/loss-coloured days,
  bucketed in your local timezone) with per-day match drill-down.
- **Season recap** — a year-in-review with hero totals, month-by-month stacked
  bars, top rival, home court, favourite surface and kudos received.
- **Privacy + blocking** — a private-account toggle (matches/stats visible to
  followers only) with a Strava-style **follow approval queue** (requests land
  in Alerts; accept/decline), and player blocking that severs follows and
  pending requests both ways, making the two players mutually invisible
  (feed, search, profiles, comments, kudos).
- **Public equipment loadout**, **achievements**, **head-to-head rivalries**,
  **comments**, **follows**, a following-only feed, **in-app + push notifications**,
  and **compass-named districts** ("North District") from your home base.

---

## API reference (selected)

All routes live under `https://<project>.supabase.co/functions/v1/api`.

| Method & path | Purpose |
|---|---|
| `POST /api/auth/login` · `GET /api/auth/username-available?username=` · `GET /api/auth/me` | Auth — sign-up is client-side via **Supabase Auth**; sign-in is proxied server-side (DB-backed brute-force throttle) so a username resolves to a session without exposing email. **Google / Apple sign-in** use the native ID-token flow client-side — see [`supabase/OAUTH_SETUP.md`](supabase/OAUTH_SETUP.md) |
| `GET /api/scheduled-matches` · `POST …` · `PATCH /:id` | Propose/accept/decline/cancel singles or doubles matches & **challenges** (`is_challenge`); a logged match links its result back |
| `GET /api/feed?scope=global\|following&before=` | Paginated match cards (keyset cursor) |
| `POST /api/matches` | Log singles or doubles (+ optional stat matrix); tagging either opposing Vollo player makes it **pending verification** |
| `GET /api/matches/pending` · `POST /api/matches/:id/verify` | Matches awaiting my confirmation; either tagged opposing player confirms (counts) or rejects (disputed) |
| `POST /api/matches/:id/kudos` · `DELETE …` | Kudos (idempotent) |
| `GET /api/matches/:id/comments` · `POST …` | Comments (composite keyset cursor) |
| `GET /api/courts?lat=&lng=&radius_km=` | Nearby courts (PostGIS `ST_DWithin`) |
| `GET /api/courts/discover?min_lng=&min_lat=&max_lng=&max_lat=` | Import + name + group OSM courts into facility sectors, list them (`import=0` = DB-only fast paint) |
| `POST /api/courts` | Add a court — a shared pin every user then sees |
| `GET /api/courts/:id/leaderboard` | 30-day court leaderboard |
| `GET /api/courts/geocode?q=` · `GET /api/courts/reverse-geocode?lat=&lng=` | Free Nominatim/Geoapify geocoding |
| `PATCH /api/users/me` | Update profile + public equipment loadout (media URLs must point at Vollo storage) |
| `GET /api/territories?min_lng=&min_lat=&max_lng=&max_lat=` | Territory polygons (GeoJSON) |
| `GET /api/users/search?q=` | Find players by name/username (to follow / tag) |
| `GET /api/users/:username/analytics` | Full performance profile |
| `GET /api/users/:username/records` · `…/calendar?year=&month=` · `…/year-in-review?year=` | Trophy case, training-log calendar, season recap (all privacy/block-guarded) |
| `GET /api/users/me/goals` · `POST …` · `DELETE …/:id` | Weekly/monthly goals with live progress (POST retargets) |
| `GET /api/clubs` · `GET /api/clubs/mine` · `POST /api/clubs` | Discover/search clubs, my clubs, start a club |
| `GET /api/clubs/:id` · `…/leaderboard` · `…/feed` · `POST`/`DELETE …/join` | Club detail + members, 30-day leaderboard, shared feed, join/leave |
| `POST /api/users/:username/block` · `DELETE …` · `GET /api/users/me/blocks` | Block/unblock a player, list blocked players |
| `GET /api/users/me/follow-requests` · `POST …/:userId` | Private-account follow approval queue (accept/decline) |
| `DELETE /api/users/me` | Delete your account (cascades all owned data) |

---

## Testing

The production verification workflow runs on every push and pull request. It
uses read-only repository permissions and checks the repository tests, a clean
mobile lockfile install, TypeScript, ESLint, public Expo configuration, Android
and iOS production exports, the Edge function against its frozen Deno lockfile,
and every database migration on a clean local Supabase instance followed by
pgTAP invariants and PL/pgSQL linting.

Run the same fast checks locally:

    npm test
    npm run verify:mobile
    npm run verify:edge

The Edge command requires Deno 2.9.2. CI pins Node.js 24.18.0, Deno 2.9.2, and
the exact commit SHA for every GitHub Action used by the workflow.

### Read-only API load test

The load runner never accepts an arbitrary path or HTTP method. It can only GET
the bounded public health, feed, and courts endpoints; it rejects redirects and
non-HTTPS remote URLs, validates each successful JSON response shape, applies
per-request timeouts and response-size caps, and stops early when a sustained
outage opens its circuit breaker. It does not run automatically in CI, so
production is only exercised intentionally.

Start with the default health-only probe (40 requests, concurrency 4):

    VOLLO_API_URL=https://<project>.supabase.co/functions/v1/api npm run load:test

PowerShell:

    $env:VOLLO_API_URL='https://<project>.supabase.co/functions/v1/api'; npm.cmd run load:test

Exercise all allowlisted public reads with explicit thresholds:

    npm run load:test -- --endpoint health,feed,courts --requests 200 --concurrency 10 --timeout-ms 5000 --max-p95-ms 2500 --max-error-rate 1

Run npm run load:test -- --help for the limits and all options. Keep production
runs deliberate and increase traffic gradually; use a staging deployment for
larger capacity experiments.

#### Production capacity baseline

The 2026-07-10 production baseline, after routing the Edge Function through the
transaction pooler, established the following raw API envelope. These are
capacity observations for the current Supabase project, not a permanent SLA:

| Workload | Result | Observed p95 |
| --- | --- | --- |
| 200 mixed health/feed/courts reads, concurrency 10 | 200/200, 0 errors | 983 ms |
| 300 feed/courts reads, concurrency 15 | 300/300, 0 errors | 1,006 ms |
| 400 feed/courts reads, concurrency 20 | 399/400; one controlled HTTP 503 | 1,127 ms |
| 500 feed/courts reads, concurrency 25 | 6.2-7.2% controlled HTTP 503 | 991-1,089 ms |

Treat concurrency 15 (about 22 database reads/second in this dataset) as the
verified zero-error envelope. Saturation is fail-safe: the API returns a
sanitized `service_unavailable` response with `Retry-After`, and the mobile
client retries a safe GET/HEAD once without replaying mutations. Before traffic
regularly approaches this boundary, re-run the same test against staging and
raise Supavisor/compute capacity based on measured database headroom; do not
raise PostgreSQL connection limits blindly. Re-baseline after plan, region,
schema, query, or pooler changes.

After each Edge deployment, rerun the credential-free security contract probes:

```bash
VOLLO_API_URL=https://<project-ref>.supabase.co/functions/v1/api npm run security:smoke
```

The command accepts only canonical Supabase Edge hosts and checks the public
health response, private-route auth boundary, invalid-token caching, UUID
validation, CORS preflight, security headers, request IDs, and the 64 KiB body
ceiling. It carries no valid credentials and cannot perform an authorized write.

## Release checklist

Code-level production checks are automated, but a release still depends on
environment-owned credentials that never belong in source control:

- Require a green `Production verification` workflow, then apply every migration
  and deploy the matching Edge function from the same commit. Provision the
  environment-specific Vault `project_url` first. For database traffic, set a
  complete transaction-mode `DATABASE_POOL_URL`, or set `DATABASE_POOL_HOST` to
  the project's trusted shared-pooler hostname; the latter safely reuses the
  credential from Supabase's injected `SUPABASE_DB_URL` on port 6543.
- Keep email confirmation enabled, allow-list `vollo://reset-password`, and set up
  a production SMTP provider, abuse limits, and provider credentials in Supabase
  Auth. Apple remains hidden until its App ID/capability/provider are provisioned;
  iOS Google remains hidden until its iOS client ID is supplied.
- The GitHub APK currently uses in-app alerts. Configure Android FCM credentials,
  add the matching Firebase client configuration at build time, rebuild, and
  exercise foreground/background delivery before claiming remote push support.
- Keep the GitHub release notes, APK checksum, [Privacy Policy](PRIVACY.md),
  [Terms of Use](TERMS.md), and [Security Policy](SECURITY.md) current. Complete
  store-specific data-safety labels and metadata only when a store release begins.
- On at least one current iPhone and Android device, smoke-test sign-up/sign-in,
  recovery, logging/verifying/deleting a match, photo/profile uploads, privacy and
  blocks, courts/territories, notifications, and all Photo/Court/Sticker share modes.
- Connect mobile crash reporting and an Edge log drain; preserve `X-Request-Id`
  when correlating client reports with backend failures.

---

## License

MIT © 2026 Srivats Iyer
