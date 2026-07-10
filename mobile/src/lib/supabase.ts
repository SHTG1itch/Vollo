// Supabase client singleton for Vollo mobile.
//
// Auth (sign-up / sign-in / session refresh) goes straight to Supabase Auth from
// the device; the resulting access token is sent as the bearer to our Edge
// Function API. Native refresh tokens are persisted in the OS Keychain/Keystore
// (with a one-time migration from the old AsyncStorage value) and auto-refreshed,
// so users stay signed in across launches without exposing tokens in plaintext.
import 'react-native-url-polyfill/auto';
import { AppState } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import { authStorage } from './authStorage';

const extra = Constants.expoConfig?.extra as
  | { supabaseUrl?: string; supabaseAnonKey?: string }
  | undefined;

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? extra?.supabaseUrl ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? extra?.supabaseAnonKey ?? '';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // A misconfigured build can't authenticate — fail loudly in dev rather than
  // silently 401 on every request.
  throw new Error('Supabase URL/anon key missing — set expo.extra.supabaseUrl / supabaseAnonKey.');
}

let parsedSupabaseUrl: URL;
try {
  parsedSupabaseUrl = new URL(SUPABASE_URL);
} catch {
  throw new Error('Supabase URL must be a valid absolute URL.');
}
if (parsedSupabaseUrl.protocol !== 'http:' && parsedSupabaseUrl.protocol !== 'https:') {
  throw new Error('Supabase URL must use HTTP or HTTPS.');
}
if (!__DEV__ && parsedSupabaseUrl.protocol !== 'https:') {
  throw new Error('Supabase URL must use HTTPS in a release build.');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: authStorage,
    autoRefreshToken: true,
    persistSession: true,
    // Mobile deep links can be claimed by another installed app. PKCE keeps an
    // intercepted callback code useless without the verifier stored on the
    // device that initiated the confirmation or recovery flow.
    flowType: 'pkce',
    // Mobile uses native deep links, not URL-based session detection.
    detectSessionInUrl: false,
  },
});

// The documented React Native pattern: the auto-refresh timer should only run
// while the app is foregrounded. Backgrounded JS timers are unreliable anyway;
// on return to 'active', startAutoRefresh immediately refreshes an expired
// session instead of waiting for the next tick.
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    void supabase.auth.startAutoRefresh();
  } else {
    void supabase.auth.stopAutoRefresh();
  }
});
