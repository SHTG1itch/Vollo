import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
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
import { takeRegisteredPushToken } from '../services/push';
import { useFeed } from './feed';
import { useNotifications } from './notifications';
import type { User } from '../types';
import { parsePasswordRecoveryLink } from '../utils/authRecovery';
import { CURRENT_TERMS_VERSION } from '../policy/terms';

const PASSWORD_RECOVERY_ACCOUNT_KEY = 'vollo:password-recovery-account';
const PENDING_APPLE_NAME_KEY = 'vollo:pending-apple-name';
const startupRecoveryAccount = AsyncStorage.getItem(PASSWORD_RECOVERY_ACCOUNT_KEY).catch(() => null);

interface AuthState {
  user: User | null;
  /** Supabase auth identity for the installed session. Unlike `user`, this is
   * available before `/auth/me` loads and changes only at account boundaries. */
  accountId: string | null;
  /** The current Supabase access token, mirrored here so the navigator can gate
   *  on it. Kept in sync by the onAuthStateChange bridge below. */
  token: string | null;
  hydrated: boolean;
  /** Set when persisted-session hydration failed; rendering still proceeds so
   *  a storage failure can never strand the app on its splash screen. */
  hydrationError: string | null;
  passwordRecovery: boolean;
  passwordRecoveryError: string | null;
  /** True when the most recent `/auth/me` load failed while no profile was yet
   *  loaded. Lets the Me tab offer a retry instead of spinning forever; a
   *  transient failure that still has a cached `user` leaves this false. */
  meError: boolean;
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
  requestPasswordReset: (email: string) => Promise<void>;
  beginPasswordRecovery: (url: string) => Promise<boolean>;
  completePasswordRecovery: (password: string) => Promise<void>;
  cancelPasswordRecovery: () => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User) => void;
  refreshMe: () => Promise<void>;
  acceptTerms: (version: string) => Promise<void>;
}

export const useAuth = create<AuthState>()((set, get) => ({
  user: null,
  accountId: null,
  token: null,
  hydrated: false,
  hydrationError: null,
  passwordRecovery: false,
  passwordRecoveryError: null,
  meError: false,

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
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
      nonce: credential.nonce,
    });
    if (error) throw new Error(error.message);

    // Apple discloses a name only on the first authorization. Preserve it until
    // this new account accepts the Terms gate; profile mutations are correctly
    // blocked before then. The auth id prevents a later account from receiving it.
    if (credential.fullName && data.user) {
      await AsyncStorage.setItem(
        PENDING_APPLE_NAME_KEY,
        JSON.stringify({ authId: data.user.id, name: credential.fullName }),
      ).catch(() => {});
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

  requestPasswordReset: async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: 'vollo://reset-password',
    });
    if (error) throw new Error(error.message);
  },

  beginPasswordRecovery: async (url) => {
    const recovery = parsePasswordRecoveryLink(url);
    if (!recovery) return false;

    set({ passwordRecovery: true, passwordRecoveryError: null });
    if (recovery.kind === 'invalid') {
      set({ passwordRecoveryError: 'This reset link is incomplete or expired. Request a new one.' });
      return true;
    }

    try {
      const result = recovery.kind === 'code'
        ? await supabase.auth.exchangeCodeForSession(recovery.code)
        : await supabase.auth.setSession({
            access_token: recovery.accessToken,
            refresh_token: recovery.refreshToken,
          });
      if (result.error || !result.data.session) throw result.error ?? new Error('No recovery session');
      // A recovery session is a real persisted Supabase session. Remember its
      // account so killing/reopening the app cannot accidentally treat it as a
      // completed normal sign-in and bypass the password-change screen.
      await AsyncStorage.setItem(PASSWORD_RECOVERY_ACCOUNT_KEY, result.data.session.user.id);
    } catch {
      // Never surface provider details or callback credentials in the UI.
      set({ passwordRecoveryError: 'This reset link is invalid or expired. Request a new one.' });
    }
    return true;
  },

  completePasswordRecovery: async (password) => {
    if (password.length < 8 || password.length > 72) {
      throw new Error('Password must be between 8 and 72 characters.');
    }
    if (!get().passwordRecovery || !get().token) {
      throw new Error('Open a valid password-reset link before choosing a new password.');
    }
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw new Error(error.message);
    // The password change is already committed remotely. A local storage
    // cleanup failure must not report that successful security action as a
    // failure or trap the user on a form whose old password is already invalid.
    await AsyncStorage.removeItem(PASSWORD_RECOVERY_ACCOUNT_KEY).catch(() => {});
    set({ passwordRecovery: false, passwordRecoveryError: null });
  },

  cancelPasswordRecovery: async () => {
    set({ passwordRecovery: false, passwordRecoveryError: null });
    await AsyncStorage.removeItem(PASSWORD_RECOVERY_ACCOUNT_KEY).catch(() => {});
    // A recovery callback creates a real authenticated session. Do not leave it
    // active if the user abandons the password change.
    applySession(null, null);
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  },

  logout: async () => {
    // Idempotent: the client's unauthorized handler may already have torn the
    // session down — a second call must not re-run the sign-out side effects.
    if (!get().token) return;
    // Consume the old token once and dispatch cleanup with a bearer snapshot.
    // The UI session is cleared immediately below, but sign-out gives this
    // privacy-sensitive deletion a short bounded window to reach the server.
    const pushToken = takeRegisteredPushToken();
    const unregister = pushToken
      ? api.unregisterPushToken(pushToken).catch(() => undefined)
      : Promise.resolve();

    // Clear navigation state, the API bearer, and account-owned caches before
    // Supabase's network revocation. The UI must not remain signed in while a
    // slow or offline sign-out request is pending.
    applySession(null, null);
    await Promise.race([
      unregister,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await supabase.auth.signOut().catch(() => {});
  },

  setUser: (user) => set({ user }),

  acceptTerms: async (version) => {
    const { user } = await api.acceptTerms(version);
    set({ user, meError: false });
    await applyPendingAppleName();
  },

  refreshMe: async () => {
    if (!get().token) return;
    try {
      const { user } = await api.me();
      set({ user, meError: false });
      await applyPendingAppleName();
    } catch {
      // Swallow the failure for session lifetime: a network blip on cold start
      // must NOT nuke a valid session, and a real 401 has already been handled
      // by the client's setUnauthorizedHandler (which owns the sign-out path).
      // But if we still have no profile to show, surface an error flag so the Me
      // tab can offer a retry instead of an indefinite spinner. A transient
      // failure that still has a cached user stays silent.
      if (!get().user) set({ meError: true });
    }
  },
}));

async function applyPendingAppleName(): Promise<void> {
  const state = useAuth.getState();
  const me = state.user;
  if (!me || me.terms_version !== CURRENT_TERMS_VERSION || !state.accountId) return;
  try {
    const raw = await AsyncStorage.getItem(PENDING_APPLE_NAME_KEY);
    if (!raw) return;
    const pending = JSON.parse(raw) as { authId?: unknown; name?: unknown };
    if (pending.authId !== state.accountId) return;
    if (typeof pending.name === 'string' && pending.name.trim() && (me.display_name === me.username || !me.display_name.trim())) {
      const { user } = await api.updateProfile({ display_name: pending.name.trim() });
      if (useAuth.getState().accountId === pending.authId) useAuth.setState({ user });
    }
    await AsyncStorage.removeItem(PENDING_APPLE_NAME_KEY);
  } catch {
    // Keep the one-time value for a later refresh; users can always edit it too.
  }
}

// ── Supabase session → app auth state bridge ───────────────────────────────
let initialized = false;
let authBridgeEvent = 0;
const HYDRATION_TIMEOUT_MS = 10_000;
const hydrationWatchdog = setTimeout(() => {
  if (useAuth.getState().hydrated) return;
  // Fail closed with no API bearer. A late Supabase event can still restore the
  // session, but a wedged native storage bridge can never strand the splash.
  initialized = true;
  useAuth.setState({
    hydrated: true,
    hydrationError: 'Saved sign-in took too long to restore. Please sign in again.',
  });
}, HYDRATION_TIMEOUT_MS);

function finishHydration(hydrationError: string | null): void {
  clearTimeout(hydrationWatchdog);
  useAuth.setState({ hydrated: true, hydrationError });
}

function applySession(token: string | null, accountId: string | null): void {
  const previousGeneration = getAuthGeneration();
  setAuthToken(token, accountId);
  const changedSession = previousGeneration !== getAuthGeneration();
  if (changedSession) {
    // Drop the previous profile and account-owned caches before rendering the
    // signed-in replacement (or the signed-out navigator).
    useAuth.setState({ token, accountId, user: null, meError: false });
    useFeed.getState().reset();
    useNotifications.getState().reset();
  } else {
    useAuth.setState({ token, accountId });
  }
  if (token && !useAuth.getState().passwordRecovery) void useAuth.getState().refreshMe();
}

supabase.auth.onAuthStateChange((event, session) => {
  const bridgeEvent = ++authBridgeEvent;
  if (!initialized) {
    initialized = true;
  }
  void (async () => {
    let recovery = useAuth.getState().passwordRecovery;
    let recoveryError = useAuth.getState().passwordRecoveryError;
    if (event === 'INITIAL_SESSION') {
      const recoveryAccount = await startupRecoveryAccount;
      recovery = Boolean(session && recoveryAccount === session.user.id);
      recoveryError = null;
      if (recoveryAccount && !recovery) {
        await AsyncStorage.removeItem(PASSWORD_RECOVERY_ACCOUNT_KEY).catch(() => {});
      }
    } else if (event === 'PASSWORD_RECOVERY') {
      recovery = true;
      recoveryError = null;
      if (session) {
        await AsyncStorage.setItem(PASSWORD_RECOVERY_ACCOUNT_KEY, session.user.id).catch(() => {});
      }
    } else if (!session && recovery) {
      // An expired/revoked recovery session must not leave an endless spinner.
      recoveryError = 'This reset session expired. Request a new password-reset link.';
      await AsyncStorage.removeItem(PASSWORD_RECOVERY_ACCOUNT_KEY).catch(() => {});
    }
    if (bridgeEvent !== authBridgeEvent) return;
    useAuth.setState({ passwordRecovery: recovery, passwordRecoveryError: recoveryError });
    applySession(session?.access_token ?? null, session?.user.id ?? null);
    finishHydration(null);
  })();
});

// Fallback in case the listener hasn't fired yet — resolve the stored session
// directly so the splash can never hang waiting to hydrate.
void supabase.auth
  .getSession()
  .then(async ({ data, error }) => {
    if (initialized) return;
    if (error) throw error;
    const recoveryAccount = await startupRecoveryAccount;
    const recovery = Boolean(data.session && recoveryAccount === data.session.user.id);
    if (recoveryAccount && !recovery) {
      await AsyncStorage.removeItem(PASSWORD_RECOVERY_ACCOUNT_KEY).catch(() => {});
    }
    useAuth.setState({ passwordRecovery: recovery, passwordRecoveryError: null });
    applySession(data.session?.access_token ?? null, data.session?.user.id ?? null);
    initialized = true;
    finishHydration(null);
  })
  .catch(() => {
    if (initialized) return;
    initialized = true;
    finishHydration('Could not restore the saved session. Please sign in again.');
  });

// On a 401 the client first asks us for a fresh token — an access token that
// expired while backgrounded is refreshable and must not end the session.
setSessionRefresher(async (generation) => {
  if (!isAuthGenerationCurrent(generation)) return undefined;
  const { data, error } = await supabase.auth.refreshSession();
  if (!isAuthGenerationCurrent(generation)) return undefined;
  if (error) {
    const status = (error as { status?: number }).status ?? 0;
    const definitelyInvalid = status >= 400 && status < 500 && status !== 429;
    return definitelyInvalid ? null : undefined;
  }
  if (!data.session) return null;
  // onAuthStateChange mirrors the new token too; return it so the client can
  // retry the failed request immediately without waiting for that bridge.
  return data.session.access_token;
});

// Only a definitive refresh rejection reaches this handler. Transient provider
// and network failures surface a retryable 503 while preserving the session.
setUnauthorizedHandler((generation) => {
  if (!isAuthGenerationCurrent(generation) || !useAuth.getState().token) return;
  applySession(null, null);
  void supabase.auth.signOut().catch(() => {});
});
