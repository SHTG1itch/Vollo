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
   **Vollo Rating** (Elo), and a rolling **streak heat index**.
3. **The Geospatial Domination Engine** — win matches at courts to top their 30-day
   leaderboard; control ≥3 courts within 10 km and PostGIS draws a neon-green
   **convex-hull territory** over the map. Lose your grip and the polygon contracts,
   mutates, or shatters — with push notifications when a rival cuts off your district.

---

## Tech stack (100% free / open source)

| Layer | Choice | Why |
|------|--------|-----|
| Mobile | **Expo (React Native) + TypeScript** | One codebase → iOS & Android; EAS free cloud builds |
| State | **Zustand** | Tiny, minimal re-renders, AsyncStorage persistence |
| Maps | **react-native-maps + OpenStreetMap raster tiles** | Bypasses commercial vector-map licensing |
| Lists | **@shopify/flash-list** | High-performance feed rendering |
| API | **Node.js + Express + TypeScript** | Shared language with the app |
| Database | **PostgreSQL + PostGIS** | Native spatial geometry + `ST_ConvexHull` |
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

### Court leaderboards
Per court, over a trailing **30-day window**, players are ranked by `Σ MatchScore`.
Rank #1 is the **Court Controller**; ranks 1–2 "control" a court for territory purposes.

### The Domination Engine (convex hull)
On every match (and on a 6-hourly sweep) the engine, for each affected player:

1. pulls **controlled courts** (rank ≤ 2 in the 30-day window),
2. **clusters** them by the 10 km radius (single-linkage),
3. for each cluster of **≥ 3 courts**, runs the spec's PostGIS query:

   ```sql
   SELECT ST_AsGeoJSON(ST_ConvexHull(ST_Collect(court_geom)))
   FROM courts WHERE id = ANY(:controlled_court_ids);
   ```
4. **diffs** against existing territories → fires `territory_gained` / `territory_changed`
   / `territory_lost` notifications, and `court_taken` / `court_dethroned` when control
   flips. The polygon is served as GeoJSON and rendered as a semi-transparent neon-green
   `<Polygon/>` (`rgba(50,205,50,0.20)`).

A pure-TypeScript mirror of the geometry (haversine, clustering, monotone-chain hull,
compass district naming) lives in `backend/src/utils/geo.ts` and is fully unit-tested.

---

## Beyond the spec (added features)

- **Per-surface Vollo Rating** — Elo with a game-margin multiplier; mirrored to a
  registered opponent.
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
| `POST /api/auth/register` · `POST /api/auth/login` · `GET /api/auth/me` | Auth (JWT) |
| `GET /api/feed?scope=global\|following&before=` | Paginated match cards |
| `POST /api/matches` | Log a match (+ optional stat matrix) |
| `POST /api/matches/:id/kudos` · `DELETE …` | Kudos (idempotent) |
| `GET /api/courts?lat=&lng=&radius_km=` | Nearby courts (PostGIS `ST_DWithin`) |
| `GET /api/courts/:id/leaderboard` | 30-day court leaderboard |
| `GET /api/courts/geocode?q=` | Free Nominatim/Geoapify geocoding |
| `GET /api/territories?min_lng=&min_lat=&max_lng=&max_lat=` | Territory polygons (GeoJSON) |
| `GET /api/users/:username/analytics` | Full performance profile |

---

## Testing

```bash
cd backend && npm test        # 28 vitest cases: scoring, streak, geo, rating
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
