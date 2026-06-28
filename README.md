<div align="center">

# 🎾 Vollo

### Strava for tennis — match analytics + geospatial territorial domination

Log matches, track multi-dimensional performance by surface, and **claim real-world
courts to project colored territory polygons across the map.** Built end-to-end on
free / open-source tooling for a **$0.00 infrastructure runway.**

</div>

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
   Matches against another Vollo player only count once that opponent **verifies**
   them, so domination and Elo stay honest.

---

## Tech stack (100% free / open source)

| Layer | Choice | Why |
|------|--------|-----|
| Mobile | **Expo (React Native) + TypeScript** | One codebase → iOS & Android; EAS free cloud builds |
| State | **Zustand** | Tiny, minimal re-renders, AsyncStorage persistence |
| Maps | **react-native-maps + OpenStreetMap raster tiles** | Bypasses commercial vector-map licensing |
| Courts | **OpenStreetMap Overpass API** | Imports real-world tennis courts into the map at $0 (no key) |
| Lists | **@shopify/flash-list** | High-performance feed rendering |
| API | **Node.js + Express + TypeScript** | Shared language with the app |
| Database | **PostgreSQL + PostGIS** | Native spatial geometry + `ST_ConcaveHull` territories |
| Geocoding | **Nominatim (OSM)** / Geoapify free tier | Address → coordinates at no cost |
| Hosting | **Render** (API) + **Supabase** (Postgres/PostGIS) free tiers | $0 runway |
| Push | **Expo Push** → APNs + FCM | Free relay |

---

## Monorepo layout

```
Vollo/
├── backend/                 # Express + PostGIS API
│   ├── db/migrations/        # SQL schema (PostGIS, leaderboard + feed views)
│   └── src/
│       ├── services/         # scoring, streak, rating, territory (convex hull), analytics…
│       ├── routes/           # auth, matches, feed, courts, territories, users, notifications
│       ├── workers/          # rolling streak + territory cron sweeps
│       ├── utils/geo.ts      # haversine, clustering, compass naming, hull (testable mirror)
│       └── db/               # pool, migration runner, seed
├── mobile/                  # Expo app
│   └── src/
│       ├── api/              # typed fetch client
│       ├── store/            # Zustand: auth, feed (optimistic kudos), notifications
│       ├── components/       # MatchCard, KudosButton, ScoreInput, charts…
│       ├── screens/          # Feed, Map, LogMatch, MatchDetail, Profile/analytics…
│       └── navigation/       # tabs + root stack
├── docker-compose.yml       # local PostGIS
└── render.yaml              # one-click $0 deploy blueprint
```

---

## Quickstart (local)

### 1. Database (PostGIS via Docker)

```bash
docker compose up -d          # starts postgis/postgis on localhost:5432
```

### 2. Backend API

```bash
cd backend
cp .env.example .env          # defaults already match docker-compose
npm install
npm run migrate               # apply the schema
npm run seed                  # demo users, NYC courts, matches, territories
npm run dev                   # http://localhost:4000
```

Demo login: **`srivats` / `volley123`**

### 3. Mobile app

```bash
cd mobile
npm install
# On a physical device, point the app at your machine's LAN IP:
EXPO_PUBLIC_API_URL=http://<your-lan-ip>:4000 npx expo start
```

Open in **Expo Go** (scan the QR) or an emulator. Sign in with the demo account.

> **Android map note:** the OSM raster tiles are 100% free. `react-native-maps`
> still uses the device's base map provider underneath; on Android you may add a
> (free) Google Maps API key for the base layer, but all *tiles* you see are OSM.

---

## How the systems work

### Match scoring
`score_array` like `[[6,4],[2,6],[7,6]]` is analyzed into sets/games won-lost and a
result. A deciding match-tiebreak (e.g. `[10,8]`) counts as one game-equivalent.

```
MatchScore = (gamesWon − gamesLost) × StreakModifier
```

### Temporal heat index (streaks)
Activity is bucketed into rolling 7-day windows. The streak is the run of consecutive
windows with ≥1 match; the modifier scales up `+0.1` per maintained week, capped at
`×2.0`. A daily cron sweep decays modifiers the moment a window lapses.

### Match verification (competitive integrity)
A match logged against a **registered Vollo player** starts `pending` and counts for
**nothing** — not Elo, streak, court leaderboard or territory — until that opponent
**confirms** it (they get a push to Confirm/Dispute). A disputed match is `rejected`
and never counts; a match against an off-app opponent is `auto` and counts immediately.
The court leaderboard view, streak, analytics and achievements all read only
`auto`/`verified` matches, and the confirm transition is status-guarded so a double-tap
can't apply Elo twice.

### Court leaderboards
Per court, over a trailing **30-day window**, players are ranked by `Σ MatchScore`
(verified matches only). Rank #1 is the **Court Controller**; ranks 1–2 "control" a
court for territory purposes. When a challenger climbs to within ~70 % of the
controller's score at a court inside their territory, the controller gets a
**⚔️ Turf War Initiated** alert.

### The Domination Engine (concave hull)
On every counting match (and on a 6-hourly sweep) the engine, for each affected player:

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
   flips. The polygon is served as GeoJSON and rendered as a semi-transparent neon-green
   `<Polygon/>` (`rgba(50,205,50,0.20)`).

A pure-TypeScript mirror of the geometry (haversine, clustering, monotone-chain hull,
compass district naming) lives in `backend/src/utils/geo.ts` and is fully unit-tested.

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

## Beyond the spec (added features)

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
- **Match → location → domination** — every match can be tied to a court/sector,
  which feeds the 30-day court leaderboard and the concave-hull territory engine.
- **Match verification** — a match tagged against a registered player only counts
  once they confirm it (pending → verified / rejected), keeping Elo and turf honest.
- **Turf Wars** — when a rival closes in on a court you control inside your
  territory, you get a "⚔️ Turf War Initiated" alert so control is a constant fight.
- **Challenge a player** — a ⚔️ Challenge button on any profile (or on a domination
  zone's card) proposes a schedulable match; the opponent gets a challenge push.
- **Tap a zone to see who to beat** — the map's sector card shows the dominant
  player and how many wins they hold there, so you know the bar to claim it.
- **Fast, crash-free map** — courts paint instantly from the DB while new ones
  import from OSM in the background. All native overlays unmount while you pan/zoom
  and remount only once the gesture settles (so there's zero native-view churn —
  the dominant crash vector), overlays commit on the idle frame and reuse their
  native views when unchanged, sub-threshold pans coalesce, zoom is bounded, and
  vertices/markers are capped.
- **Public equipment loadout** — racquet, strings, tension and shoes on every
  profile, so you can see what gear strong players use.
- **Per-surface Vollo Rating (Bayesian)** — a Gaussian skill posterior N(μ, σ)
  per surface, updated Bayesianly (Glicko-style) per match: each result is an
  update layer that adds precision (so a new player's rating moves fast and a
  seasoned one barely budges), with the game margin weighting the evidence.
  Applied only once a match counts (verified/auto). Only the logging player's
  rating moves (no unilateral tanking); ratings are a pure replay of match
  history, so deleting a match recomputes exactly.
- **Achievements / badges** — Clay Grinder, Comeback King, Territory Lord, On Fire…
- **Head-to-head rivalries**, **comments**, **follows**, and a following-only feed.
- **Playstyle labeling** — "Clay Court Grinder" vs "Hard Court Specialist" from your
  surface win-rates and rally tendencies.
- **In-app + Expo push notifications** and an Activity tab with unread badge.
- **Compass-named districts** ("North District") derived from your home base.

---

## API reference (selected)

| Method & path | Purpose |
|---|---|
| `POST /api/auth/login` · `GET /api/auth/username-available?username=` · `GET /api/auth/me` | Auth — sign-up is client-side via **Supabase Auth**; sign-in is proxied server-side so a username resolves to a session without exposing email; the function validates the token and resolves the profile. **Google / Apple sign-in** use the native ID-token flow client-side (no new route) and validate through the same path — see [`supabase/OAUTH_SETUP.md`](supabase/OAUTH_SETUP.md). (The legacy Express backend in `backend/` still uses custom JWT.) |
| `GET /api/scheduled-matches` · `POST …` · `PATCH /:id` | Propose/accept/decline/cancel matches & **challenges** (`is_challenge`); a logged match links its result back |
| `GET /api/feed?scope=global\|following&before=` | Paginated match cards |
| `POST /api/matches` | Log a match (+ optional stat matrix); tagging a Vollo player makes it **pending verification** |
| `GET /api/matches/pending` · `POST /api/matches/:id/verify` | Matches awaiting my confirmation; opponent confirms (counts) or rejects (disputed) |
| `POST /api/matches/:id/kudos` · `DELETE …` | Kudos (idempotent) |
| `GET /api/courts?lat=&lng=&radius_km=` | Nearby courts (PostGIS `ST_DWithin`) |
| `GET /api/courts/discover?min_lng=&min_lat=&max_lng=&max_lat=` | Import + name + group OSM courts into facility sectors, list them (`import=0` = DB-only fast paint) |
| `POST /api/courts` | Add a court — a shared pin every user then sees |
| `GET /api/courts/:id/leaderboard` | 30-day court leaderboard |
| `GET /api/courts/geocode?q=` | Free Nominatim/Geoapify geocoding |
| `GET /api/courts/reverse-geocode?lat=&lng=` | Reverse geocode a dropped pin → city/address |
| `PATCH /api/users/me` | Update profile + public equipment loadout |
| `GET /api/territories?min_lng=&min_lat=&max_lng=&max_lat=` | Territory polygons (GeoJSON) |
| `GET /api/users/search?q=` | Find players by name/username (to follow / tag) |
| `GET /api/users/:username/analytics` | Full performance profile |
| `DELETE /api/users/me` | Delete your account (cascades all owned data) |

---

## Testing

```bash
cd backend && npm test        # 36 vitest cases: scoring, streak, geo, rating
cd backend && npm run typecheck
cd mobile  && npm run typecheck
```

---

## Deploy at $0

1. **Supabase** — create a free project; PostGIS ships enabled. Copy the connection string.
2. **Render** — *New → Blueprint*, select this repo (`render.yaml`). Set `DATABASE_URL`
   (Supabase) when prompted; `JWT_SECRET` is generated. The cron sweeps run in-process
   via `START_WORKER=true`, so one free web service covers everything.
3. From the Render shell once: `npm run migrate` (and optionally `npm run seed`).
4. Point the mobile app at the deployed URL via `EXPO_PUBLIC_API_URL`, then build with
   `eas build` (free tier) for iOS/Android.

---

## License

MIT © 2026 Srivats Iyer
