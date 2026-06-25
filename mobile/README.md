# Vollo Mobile

Expo (React Native) + TypeScript client. See the [root README](../README.md) for the
full architecture.

## Run

```bash
npm install
# Physical device: point at your dev machine's LAN IP
EXPO_PUBLIC_API_URL=http://<lan-ip>:4000 npx expo start
```

Then open in **Expo Go** (scan QR) or `i` / `a` for a simulator/emulator. Demo login:
`srivats` / `volley123` (after running the backend seed).

## Configuration

- `EXPO_PUBLIC_API_URL` — API base URL (defaults to `app.json` → `extra.apiUrl` →
  `http://localhost:4000`).

## Structure

- `src/api/` — typed fetch client + base-URL config.
- `src/store/` — Zustand stores: `auth` (AsyncStorage-persisted JWT), `feed`
  (cursor pagination + optimistic kudos), `notifications`.
- `src/components/` — `MatchCard`, animated `KudosButton`, `ScoreInput`, `charts`,
  `SurfaceBadge`, shared `ui` primitives.
- `src/screens/` — Feed, Map (OSM tiles + territory polygons), LogMatch, MatchDetail,
  Courts, CourtDetail, Leaderboard, Profile/analytics, EditProfile, Notifications.
- `src/navigation/` — bottom tabs + root stack (auth-gated).

## Map / OSM

Tiles come from `https://tile.openstreetmap.org/{z}/{x}/{y}.png` via `<UrlTile/>`
with `mapType="none"` — no commercial vector-map licensing. Territory polygons are
GeoJSON from the API rendered as semi-transparent neon-green `<Polygon/>` overlays.
