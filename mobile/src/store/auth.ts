import { create } from 'zustand';
import {
  ApiError,
  api,
  getAuthGeneration,
  isAuthGenerationCurrent,
  setAuthToken,
  setSessionRefresher,
  setUnauthorizedHandler,
} from '../api/client';
import { supabase } from '../lib/supabase';
import { getAppleCredential, getGoogleIdToken, OAuthCancelled } from '../lib/oauth';
import { getRegisteredPushToken } from '../services/push';
import { useFeed } from './feed';
import { useNotifications } from './notifications';
import type { User } from '../types';

interface AuthState {
  user: User | null;
  /** The current Supabase access token, mirrored here so the navigator can gate
   *  on it. Kept in sync by the onAuthStateChange bridge below. */
  token: string | null;
  hydrated: boolean;
  /** Set when persisted-session hydration failed; rendering still proceeds so
   *  a storage failure can never strand the app on its splash screen. */
  hydrationError: string | null;
  login: (identifier: string, password: string) => Promise<void>;
  /** Native Google / Apple sign-in. Both exchange a provider ID token for a
   *  Supabase session, which flows back through onAuthStateChange like any other
   *  login. A user-cancelled sheet resolves quietly (no error). */
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
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
  hydrationError: null,

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

  // Native ID-token sign-in. signInWithIdToken establishes the session, then the
  // onAuthStateChange bridge below installs the token and runs refreshMe — the
  // same path password login takes, so nothing else changes.
  signInWithGoogle: async () => {
    let idToken: string;
    try {
      idToken = await getGoogleIdToken();
    } catch (e) {
      if (e instanceof OAuthCancelled) return; // user backed out — no-op
      throw e;
    }
    const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
    if (error) throw new Error(error.message);
  },

  signInWithApple: async () => {
    let credential;
    try {
      credential = await getAppleCredential();
    } catch (e) {
      if (e instanceof OAuthCancelled) return; // user backed out — no-op
      throw e;
    }
    const { error } = await supabase.auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken });
    if (error) throw new Error(error.message);

    // Apple discloses the user's real name only on the very first authorization,
    // and never inside the identity token — so if we got one, set it as the
    // display name, but only while the freshly-provisioned profile still carries
    // the auto-derived fallback (so we never clobber a name the user has edited).
    if (credential.fullName) {
      try {
        await get().refreshMe();
        const me = get().user;
        if (me && (me.display_name === me.username || !me.display_name.trim())) {
          const { user } = await api.updateProfile({ display_name: credential.fullName });
          set({ user });
        }
      } catch {
        /* best-effort — the user can always edit their name in-app */
      }
    }
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
    // Idempotent: the client's unauthorized handler may already have torn the
    // session down — a second call must not re-run the sign-out side effects.
    if (!get().token) return;
    // Snapshot and dispatch old-token push cleanup without awaiting it. This
    // detached request never retries under a subsequent account.
    const pushToken = getRegisteredPushToken();
    if (pushToken) api.unregisterPushTokenBestEffort(pushToken);

    // Clear navigation state, the API bearer, and account-owned caches before
    // Supabase's network revocation. The UI must not remain signed in while a
    // slow or offline sign-out request is pending.
    applySession(null, null);
    await supabase.auth.signOut().catch(() => {});
  },

  setUser: (user) => set({ user }),

  refreshMe: async () => {
    if (!get().token) return;
    try {
      const { user } = await api.me();
      set({ user });
    } catch {
      // Swallow everything: a network blip on cold start must NOT nuke a valid
      // session, and a real 401 has already been handled by the client's
      // setUnauthorizedHandler (which owns the sign-out path) — calling
      // logout() here too would duplicate the teardown.
    }
  },
}));

// ── Supabase session → app auth state bridge ───────────────────────────────
let initialized = false;

function applySession(token: string | null, accountId: string | null): void {
  const previousGeneration = getAuthGeneration();
  setAuthToken(token, accountId);
  const changedSession = previousGeneration !== getAuthGeneration();
  if (changedSession) {
    // Drop the previous profile and account-owned caches before rendering the
    // signed-in replacement (or the signed-out navigator).
    useAuth.setState({ token, user: null });
    useFeed.getState().reset();
    useNotifications.getState().reset();
  } else {
    useAuth.setState({ token });
  }
  if (token) void useAuth.getState().refreshMe();
}

supabase.auth.onAuthStateChange((_event, session) => {
  applySession(session?.access_token ?? null, session?.user.id ?? null);
  if (!initialized) {
    initialized = true;
  }
  useAuth.setState({ hydrated: true, hydrationError: null });
});

// Fallback in case the listener hasn't fired yet — resolve the stored session
// directly so the splash can never hang waiting to hydrate.
void supabase.auth
  .getSession()
  .then(({ data, error }) => {
    if (initialized) return;
    if (error) throw error;
    applySession(data.session?.access_token ?? null, data.session?.user.id ?? null);
    initialized = true;
    useAuth.setState({ hydrated: true, hydrationError: null });
  })
  .catch((error: unknown) => {
    if (initialized) return;
    initialized = true;
    useAuth.setState({
      hydrated: true,
      hydrationError: error instanceof Error ? error.message : 'Could not restore the saved session.',
    });
  });

// On a 401 the client first asks us for a fresh token — an access token that
// expired while backgrounded is refreshable and must not end the session.
setSessionRefresher(async (generation) => {
  if (!isAuthGenerationCurrent(generation)) return null;
  const { data, error } = await supabase.auth.refreshSession();
  if (!isAuthGenerationCurrent(generation) || error || !data.session) return null;
  // onAuthStateChange mirrors the new token too; return it so the client can
  // retry the failed request immediately without waiting for that bridge.
  return data.session.access_token;
});

// Only when the refresh also failed is the session truly dead — sign out cleanly.
setUnauthorizedHandler((generation) => {
  if (!isAuthGenerationCurrent(generation) || !useAuth.getState().token) return;
  applySession(null, null);
  void supabase.auth.signOut().catch(() => {});
});
