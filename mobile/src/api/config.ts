import Constants from 'expo-constants';

/**
 * Base URL of the Vollo API.
 *
 * On a physical device `localhost` points at the phone, not your dev machine —
 * set EXPO_PUBLIC_API_URL to your computer's LAN IP, e.g.:
 *   EXPO_PUBLIC_API_URL=http://192.168.1.50:4000 npx expo start
 */
const extraApiUrl = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? extraApiUrl ?? 'http://localhost:4000';
export const API_BASE = `${API_URL}/api`;
