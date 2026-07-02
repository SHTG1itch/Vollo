import Constants from 'expo-constants';

/**
 * Base URL of the Vollo API (the Supabase Edge Function).
 *
 * Normally baked in via app.json → extra.apiUrl. Override with
 * EXPO_PUBLIC_API_URL to point at a locally served function
 * (`supabase functions serve` → http://<lan-ip>:54321/functions/v1) —
 * on a physical device use your machine's LAN IP, not localhost.
 */
const extraApiUrl = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;

const configured = process.env.EXPO_PUBLIC_API_URL ?? extraApiUrl;

// In a release build the API host MUST be baked in — falling back to
// `localhost` would make every request hit the phone's own loopback and fail
// silently. In dev we default to the Supabase CLI's local functions port
// (override with a LAN IP via EXPO_PUBLIC_API_URL on a physical device).
if (!configured && !__DEV__) {
  throw new Error(
    'EXPO_PUBLIC_API_URL (or expo.extra.apiUrl) must be set in a release build — refusing to default to localhost.',
  );
}

export const API_URL = configured ?? 'http://localhost:54321/functions/v1';
export const API_BASE = `${API_URL}/api`;
