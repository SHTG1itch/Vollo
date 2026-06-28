// Native OAuth (Google / Apple) for Vollo.
//
// Both providers use the *native ID-token* flow: the platform SDK returns a
// signed identity token, which we hand to supabase.auth.signInWithIdToken. That
// establishes a normal Supabase session, so the existing onAuthStateChange
// bridge (store/auth.ts) installs the token and loads the profile exactly as it
// does for password sign-in — no new session plumbing, and the server-side login
// proxy, token validation and email/password flows are all untouched.
//
// IMPORTANT — the native SDKs are loaded LAZILY (require() inside the functions),
// never imported at the top of this module. A static `import` runs the package's
// native bootstrap the instant this file is evaluated, which throws
// "RNGoogleSignin could not be found" and crashes the whole app on any binary
// that doesn't bundle these native modules (Expo Go, or a dev client built before
// they were added). Lazy loading means nothing native is touched unless the user
// actually invokes a provider — so the app boots and email/username login works
// regardless of the running binary.
//
// Everything is also capability-gated: Google is inert unless enabled + a
// webClientId is configured, and Apple is gated on the iOS availability check.
import { Platform } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';

type GoogleModule = typeof import('@react-native-google-signin/google-signin');
type AppleModule = typeof import('expo-apple-authentication');

// Deferred loads — only run the native bootstrap when a provider is actually used.
function loadGoogle(): GoogleModule {
  return require('@react-native-google-signin/google-signin') as GoogleModule;
}
function loadApple(): AppleModule {
  return require('expo-apple-authentication') as AppleModule;
}

const extra = Constants.expoConfig?.extra as
  | { googleWebClientId?: string; googleIosClientId?: string; googleAuthEnabled?: boolean }
  | undefined;

// Public OAuth client ids (not secrets). Env wins so a build can inject them
// without editing app.json; otherwise fall back to expo.extra.
const GOOGLE_WEB_CLIENT_ID = (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? extra?.googleWebClientId ?? '').trim();
const GOOGLE_IOS_CLIENT_ID = (process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? extra?.googleIosClientId ?? '').trim();

// Master switch to hide the Google button without dropping the configured client
// id — e.g. to test the email/username flow on its own. Defaults to enabled;
// flip expo.extra.googleAuthEnabled to false (or set EXPO_PUBLIC_GOOGLE_AUTH=0)
// to turn it off, and back to re-enable. The Google Cloud / Supabase setup is
// untouched either way.
const GOOGLE_AUTH_ENABLED =
  process.env.EXPO_PUBLIC_GOOGLE_AUTH !== '0' && extra?.googleAuthEnabled !== false;

/** Thrown when the user dismisses the provider sheet. Callers treat it as a
 *  no-op (no error shown) rather than a failure. */
export class OAuthCancelled extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'OAuthCancelled';
  }
}

// ─── Google ────────────────────────────────────────────────────────────────

// Whether the native Google module can actually run in this binary. The native
// SDK exists ONLY in a custom dev/standalone build — never in Expo Go, which is
// a fixed prebuilt client. Without this gate the button would show in Expo Go and
// then throw "Cannot read property 'GoogleSignin' of undefined" when tapped
// (the require resolves but the native module is absent). Probed once and cached.
let nativeGoogleAvailable: boolean | null = null;
function isGoogleNativeAvailable(): boolean {
  if (nativeGoogleAvailable !== null) return nativeGoogleAvailable;
  // Expo Go can never bundle the native module — decide without touching require()
  // so we never run the package's native bootstrap on a binary that lacks it.
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
    nativeGoogleAvailable = false;
    return false;
  }
  // Any other binary (dev client / standalone): confirm the module is really
  // linked. The require is wrapped so an old dev client built before the module
  // was added degrades to "hidden" instead of crashing.
  try {
    const mod = loadGoogle();
    nativeGoogleAvailable = !!mod?.GoogleSignin;
  } catch {
    nativeGoogleAvailable = false;
  }
  return nativeGoogleAvailable;
}

/** True only when Google auth is enabled, a real web client id is configured, AND
 *  the native module is actually available in this binary — drives whether the
 *  "Continue with Google" button is shown at all. In Expo Go this is false (the
 *  native SDK isn't present), so the button is hidden rather than failing on tap. */
export function isGoogleConfigured(): boolean {
  return GOOGLE_AUTH_ENABLED && GOOGLE_WEB_CLIENT_ID.length > 0 && isGoogleNativeAvailable();
}

let googleConfigured = false;
function ensureGoogleConfigured(GoogleSignin: GoogleModule['GoogleSignin']): void {
  if (googleConfigured) return;
  // webClientId is what makes Google mint an ID token whose audience Supabase
  // accepts; iosClientId is only needed for the native iOS sheet.
  GoogleSignin.configure({
    webClientId: GOOGLE_WEB_CLIENT_ID,
    iosClientId: GOOGLE_IOS_CLIENT_ID || undefined,
    offlineAccess: false,
  });
  googleConfigured = true;
}

/** Run the native Google sign-in sheet and return its ID token. Throws
 *  OAuthCancelled if the user backs out. Loads the native SDK on first call. */
export async function getGoogleIdToken(): Promise<string> {
  const mod = loadGoogle();
  if (!mod?.GoogleSignin) {
    // Backstop: the gate above should already hide the button when the native
    // module is absent, but never surface the raw "Cannot read property
    // 'GoogleSignin' of undefined" if we somehow get here (e.g. Expo Go).
    throw new Error('Google sign-in needs a development or production build — it is not available in Expo Go.');
  }
  const { GoogleSignin, isSuccessResponse, isErrorWithCode, statusCodes } = mod;
  ensureGoogleConfigured(GoogleSignin);
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) throw new OAuthCancelled();
    const idToken = response.data.idToken;
    if (!idToken) {
      throw new Error('Google did not return an identity token — check the configured web client id.');
    }
    return idToken;
  } catch (e) {
    if (e instanceof OAuthCancelled) throw e;
    if (isErrorWithCode(e) && (e.code === statusCodes.SIGN_IN_CANCELLED || e.code === statusCodes.IN_PROGRESS)) {
      throw new OAuthCancelled();
    }
    throw e instanceof Error ? e : new Error('Google sign-in failed');
  }
}

// ─── Apple ─────────────────────────────────────────────────────────────────

/** Apple sign-in is iOS-only and needs the device capability (iOS 13+). Returns
 *  false (without loading the native module) on any non-iOS platform. */
export async function isAppleAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    return await loadApple().isAvailableAsync();
  } catch {
    return false;
  }
}

export interface AppleCredential {
  identityToken: string;
  /** Apple returns the user's name ONLY on the first authorization, and never in
   *  the identity token — so capture it here while we can. Null afterwards. */
  fullName: string | null;
}

export async function getAppleCredential(): Promise<AppleCredential> {
  try {
    const Apple = loadApple();
    const credential = await Apple.signInAsync({
      requestedScopes: [
        Apple.AppleAuthenticationScope.FULL_NAME,
        Apple.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!credential.identityToken) throw new Error('Apple did not return an identity token.');
    const name = [credential.fullName?.givenName, credential.fullName?.familyName]
      .filter(Boolean)
      .join(' ')
      .trim();
    return { identityToken: credential.identityToken, fullName: name.length ? name : null };
  } catch (e) {
    // expo-apple-authentication surfaces a dismissal as ERR_REQUEST_CANCELED.
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === 'ERR_REQUEST_CANCELED') {
      throw new OAuthCancelled();
    }
    throw e instanceof Error ? e : new Error('Apple sign-in failed');
  }
}

/** Lazily resolve the official Apple button component + its enums (HIG-compliant),
 *  or null if the native module isn't available. Call ONLY after isAppleAvailable()
 *  has resolved true, so the native module is never required on unsupported binaries. */
export function getAppleButton(): {
  Button: AppleModule['AppleAuthenticationButton'];
  Type: AppleModule['AppleAuthenticationButtonType'];
  Style: AppleModule['AppleAuthenticationButtonStyle'];
} | null {
  try {
    const Apple = loadApple();
    return {
      Button: Apple.AppleAuthenticationButton,
      Type: Apple.AppleAuthenticationButtonType,
      Style: Apple.AppleAuthenticationButtonStyle,
    };
  } catch {
    return null;
  }
}
