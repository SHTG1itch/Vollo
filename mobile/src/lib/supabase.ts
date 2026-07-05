// Supabase client singleton for Vollo mobile.
//
// Auth (sign-up / sign-in / session refresh) goes straight to Supabase Auth from
// the device; the resulting access token is sent as the bearer to our Edge
// Function API. The session is persisted in AsyncStorage and auto-refreshed, so
// users stay signed in across launches without us hand-rolling token storage.
import 'react-native-url-polyfill/auto';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';

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

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
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
