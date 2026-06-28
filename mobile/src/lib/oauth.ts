// Native OAuth (Google / Apple) for Vollo.
//
// Both providers use the *native ID-token* flow: the platform SDK returns a
// signed identity token, which we hand to supabase.auth.signInWithIdToken. That
// establishes a normal Supabase session, so the existing onAuthStateChange
// bridge (store/auth.ts) installs the token and loads the profile exactly as it
// does for password sign-in — no new session plumbing, and the server-side login
// proxy, token validation and email/password flows are all untouched.
//
// Everything here is capability-gated: Google is inert until a webClientId is
// configured (extra.googleWebClientId), and Apple is gated on the native
// availability check (iOS 13+). When a provider isn't set up, its button never
// renders, so this is additive and can't break the existing auth screens.
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';

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

/** True only when Google auth is enabled AND a real web client id is configured —
 *  drives whether the "Continue with Google" button is shown at all. */
export function isGoogleConfigured(): boolean {
  return GOOGLE_AUTH_ENABLED && GOOGLE_WEB_CLIENT_ID.length > 0;
}

let googleConfigured = false;
function ensureGoogleConfigured(): void {
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
 *  OAuthCancelled if the user backs out. */
export async function getGoogleIdToken(): Promise<string> {
  ensureGoogleConfigured();
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

/** Apple sign-in is iOS-only and needs the device capability (iOS 13+). */
export async function isAppleAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
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
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
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

// The official Apple button + its enums, re-exported so the UI stays HIG-compliant.
export const AppleButton = AppleAuthentication.AppleAuthenticationButton;
export const AppleButtonType = AppleAuthentication.AppleAuthenticationButtonType;
export const AppleButtonStyle = AppleAuthentication.AppleAuthenticationButtonStyle;
