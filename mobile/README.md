# Vollo Mobile

Expo (React Native) + TypeScript client. See the [root README](../README.md) for the
full architecture.

## Run

```bash
npm install
npx expo start
```

Then open in **Expo Go** (scan QR) or `i` / `a` for a simulator/emulator. The app
talks to the production Supabase Edge Function configured in `app.json → extra`.

## Configuration

- `EXPO_PUBLIC_API_URL` — API base URL override (defaults to `app.json` →
  `extra.apiUrl`, the deployed Supabase functions URL). Point it at
  `http://<lan-ip>:54321/functions/v1` when running `supabase functions serve`.
- `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` / `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` —
  optional native Google sign-in client ids (fall back to `extra`). The dynamic
  Expo config adds the iOS URL-scheme plugin only when the iOS id is valid; an
  empty id safely hides Google sign-in on iOS instead of shipping a placeholder.
- `EXPO_PUBLIC_APPLE_AUTH=1` (or `extra.appleAuthEnabled: true`) — enables the
  Apple button only after the Apple capability and Supabase provider are both
  provisioned. It is deliberately off in the committed configuration.

For password recovery, add `vollo://reset-password` to the Supabase Auth redirect
URL allow list. Reset callbacks are consumed in-app for both implicit-token and
PKCE links, and their credentials are never stored in navigation routes. The
Supabase client itself uses PKCE, so a captured callback code cannot be
exchanged on a different device.

On iOS and Android, Supabase sessions are stored in the OS Keychain/Keystore via
`expo-secure-store`. The adapter atomically chunks large sessions, is serialized
against refresh races, and migrates the previous AsyncStorage value only after a
complete secure write. Android application backup is disabled. Apple ID-token
sign-in also binds a SHA-256 nonce and passes the raw nonce to Supabase.

## Structure

- `src/api/` — typed fetch client + base-URL config (401 → session refresh + retry).
- `src/store/` — Zustand stores: `auth` (Supabase session bridge), `feed`
  (cursor pagination + optimistic kudos), `notifications`.
- `src/components/` — `MatchCard`, animated `KudosButton`, `ScoreInput`, `Toast`,
  SVG `icons`, `charts`, `SurfaceBadge`, share-to-story sheet, shared `ui` primitives.
- `src/lib/` — supabase client, native OAuth, haptics, image upload.
- `src/screens/` — Feed, Map (OSM + territory polygons), LogMatch, MatchDetail,
  Courts, CourtDetail, Leaderboard, Profile/analytics, EditProfile, Notifications.
- `src/navigation/` — bottom tabs + root stack (auth-gated) + `vollo://` deep links.

## Map / OSM

iOS renders `react-native-maps` with the native Apple Maps base; Android renders
a keyless Leaflet-in-WebView OSM map (`OsmMap`) —
react-native-maps on Android would require a Google Maps API key and crash without
one. Territory polygons are GeoJSON from the API rendered as semi-transparent
brand-green overlays.
