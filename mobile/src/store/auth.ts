import { create } from 'zustand';
import { ApiError, api, setAuthToken, setUnauthorizedHandler } from '../api/client';
import { supabase } from '../lib/supabase';
import { useFeed } from './feed';
import { useNotifications } from './notifications';
import type { User } from '../types';

interface AuthState {
  user: User | null;
  /** The current Supabase access token, mirrored here so the navigator can gate
   *  on it. Kept in sync by the onAuthStateChange bridge below. */
  token: string | null;
  hydrated: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  register: (body: { username: string; email: string; password: string; display_name: string }) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User) => void;
  refreshMe: () => Promise<void>;
}

export const useAuth = create<AuthState>()((set, get) => ({
  user: null,
  token: null,
  hydrated: false,

  // Supabase Auth signs in with an email, so resolve a typed username to its
  // email first (an address is used as-is). The session token then flows back
  // through onAuthStateChange.
  login: async (identifier, password) => {
    const id = identifier.trim();
    const email = id.includes('@') ? id : (await api.resolveEmail(id)).email;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  },

  register: async ({ username, email, password, display_name }) => {
    // Catch a taken username up front: a collision would otherwise fail opaquely
    // inside the profile-provisioning DB trigger. A 404 means it's free.
    let taken = false;
    try {
      await api.resolveEmail(username);
      taken = true;
    } catch (e) {
      if (e instanceof ApiError && e.status !== 404) {
        // Transient lookup failure — don't block; let sign-up surface any issue.
      }
    }
    if (taken) throw new Error('That username is already taken.');

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      // Read by the AFTER INSERT trigger to provision the public.users profile.
      options: { data: { username, display_name } },
    });
    if (error) throw new Error(error.message);
    if (!data.session) {
      // Email confirmation is enabled on the project — no session yet.
      throw new Error('Account created — check your email to confirm, then sign in.');
    }
  },

  logout: async () => {
    await supabase.auth.signOut().catch(() => {});
    // onAuthStateChange clears token/user and per-user caches.
  },

  setUser: (user) => set({ user }),

  refreshMe: async () => {
    if (!get().token) return;
    try {
      const { user } = await api.me();
      set({ user });
    } catch (err) {
      // Only sign out when the token is actually rejected — a network blip on
      // cold start must NOT nuke a valid session.
      if (err instanceof ApiError && err.status === 401) await get().logout();
    }
  },
}));

// ── Supabase session → app auth state bridge ───────────────────────────────
let initialized = false;

function applySession(token: string | null): void {
  const prev = useAuth.getState().token;
  setAuthToken(token);
  useAuth.setState({ token });
  if (token) {
    void useAuth.getState().refreshMe();
  } else if (prev) {
    // Signed out — drop the profile and clear per-user caches so the next
    // account never sees stale data.
    useAuth.setState({ user: null });
    useFeed.getState().reset();
    useNotifications.getState().reset();
  }
}

supabase.auth.onAuthStateChange((_event, session) => {
  applySession(session?.access_token ?? null);
  if (!initialized) {
    initialized = true;
    useAuth.setState({ hydrated: true });
  }
});

// Fallback in case the listener hasn't fired yet — resolve the stored session
// directly so the splash can never hang waiting to hydrate.
void supabase.auth.getSession().then(({ data }) => {
  if (initialized) return;
  applySession(data.session?.access_token ?? null);
  initialized = true;
  useAuth.setState({ hydrated: true });
});

// Any 401 from our API means the session is dead — sign out cleanly.
setUnauthorizedHandler(() => {
  if (useAuth.getState().token) void supabase.auth.signOut();
});
