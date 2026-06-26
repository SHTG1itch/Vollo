import Constants from 'expo-constants';

/**
 * Base URL of the Vollo API.
 *
 * On a physical device `localhost` points at the phone, not your dev machine —
 * set EXPO_PUBLIC_API_URL to your computer's LAN IP, e.g.:
 *   EXPO_PUBLIC_API_URL=http://192.168.1.50:4000 npx expo start
 */
const extraApiUrl = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;

const configured = process.env.EXPO_PUBLIC_API_URL ?? extraApiUrl;

// In a release build the API host MUST be baked in — falling back to
// `localhost` would make every request hit the phone's own loopback and fail
// silently. In dev we still default to localhost (override with a LAN IP via
// EXPO_PUBLIC_API_URL when testing on a physical device).
if (!configured && !__DEV__) {
  throw new Error(
    'EXPO_PUBLIC_API_URL (or expo.extra.apiUrl) must be set in a release build — refusing to default to localhost.',
  );
}

export const API_URL = configured ?? 'http://localhost:4000';
export const API_BASE = `${API_URL}/api`;
