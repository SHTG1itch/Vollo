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
  /** Resolves to `needsConfirmation: true` when sign-up created the account but
   *  email confirmation is required before a session exists. */
  register: (body: { username: string; email: string; password: string; display_name: string }) => Promise<{ needsConfirmation: boolean }>;
  resendConfirmation: (email: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User) => void;
  refreshMe: () => Promise<void>;
}

export const useAuth = create<AuthState>()((set, get) => ({
  user: null,
  token: null,
  hydrated: false,

  // Sign-in is proxied server-side so a typed username never has to be turned
  // into an email on the client. The proxy returns the session, which we install
  // locally; the token then flows back through onAuthStateChange.
  login: async (identifier, password) => {
    const { session } = await api.login(identifier.trim(), password);
    const { error } = await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    if (error) throw new Error(error.message);
  },

  register: async ({ username, email, password, display_name }) => {
    // Catch a taken username up front: a collision would otherwise be silently
    // suffixed by the profile-provisioning DB trigger (you'd get "srivats1").
    try {
      const { available } = await api.checkUsername(username);
      if (!available) throw new Error('That username is already taken.');
    } catch (e) {
      // A real "taken" verdict propagates; a transient lookup failure doesn't
      // block sign-up (the trigger still dedupes as a backstop).
      if (e instanceof Error && !(e instanceof ApiError)) throw e;
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      // Read by the profile-provisioning trigger once the email is confirmed.
      options: { data: { username, display_name } },
    });
    if (error) throw new Error(error.message);
    // With email confirmation on there's no session yet — the caller shows a
    // "check your inbox" state. With it off, signUp returns a session and the
    // onAuthStateChange bridge logs the user straight in.
    return { needsConfirmation: !data.session };
  },

  resendConfirmation: async (email) => {
    const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim() });
    if (error) throw new Error(error.message);
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
