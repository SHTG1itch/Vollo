# Vollo API

Express + TypeScript + PostgreSQL/PostGIS. The spatial engine behind Vollo's
territories, leaderboards and analytics. See the [root README](../README.md) for the
full picture.

## Scripts

```bash
npm run dev         # tsx watch (hot reload)
npm start           # production start (tsx)
npm run migrate     # apply db/migrations/*.sql (tracked in schema_migrations)
npm run seed        # demo data (truncates first)
npm run worker      # standalone cron sweeps  (--once to run immediately + exit)
npm run typecheck   # tsc --noEmit
npm test            # vitest
```

## Layout

- `db/migrations/` — `001_init.sql` (tables, enums, GIST indexes), `002_views_and_triggers.sql`
  (`court_leaderboard`, `match_feed`, `updated_at` triggers).
- `src/services/` — pure-logic + DB services:
  - `scoring.ts` — `score_array` → sets/games/result + `MatchScore`.
  - `streak.ts` — rolling 7-day heat index + modifier.
  - `rating.ts` — per-surface Elo.
  - `territory.ts` — the domination engine (`ST_ConvexHull`, clustering, diff, notifications).
  - `analytics.ts` — surface partitioning, stat matrix, playstyle, head-to-head.
  - `geocoding.ts`, `notifications.ts`, `achievements.ts`.
- `src/routes/` — Express routers; `src/middleware/` — auth/error/validation.
- `src/workers/` — cron sweeps (also runnable in-process via `START_WORKER=true`).
- `src/utils/geo.ts` — testable geometry mirror.

## Environment

Copy `.env.example` → `.env`. Every value has a working local default matching
`docker-compose.yml`. Key flags: `DATABASE_URL`, `JWT_SECRET`, `TERRITORY_RADIUS_KM`,
`TERRITORY_MIN_COURTS`, `STREAK_*`, `START_WORKER`.
