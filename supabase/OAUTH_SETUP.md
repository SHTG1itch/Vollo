# Google & Apple sign-in setup

Vollo signs in with Google and Apple using the **native ID-token flow**: the
platform SDK returns a signed identity token and the app exchanges it for a
Supabase session with `supabase.auth.signInWithIdToken`. That session flows back
through the same `onAuthStateChange` bridge as password login, so **no backend
route, the username login proxy, or the email/password flow changes**.

All the app code already ships (migration `015`, `mobile/src/lib/oauth.ts`, the
`SocialAuth` buttons, the Expo plugins). What remains is the parts that can only
be done in a console with your own developer accounts: create the OAuth clients,
enable the providers in Supabase, and paste the client ids back into the app.

> The buttons are **capability-gated**: until you complete the steps below the
> Google button is hidden (no `googleWebClientId`) and the Apple button only
> appears on a real iOS build. So a half-finished setup never breaks the
> existing sign-in screen.

> **You need a custom dev build, not Expo Go.** Both providers are native
> modules, so test on an EAS dev build / TestFlight / a release build — not Expo
> Go (which can't load them; the buttons simply stay hidden there).

---

## 1. Supabase dashboard (both providers)

Authentication → **Providers**. Leave **email confirmation ON** (Authentication →
Providers → Email) — OAuth users are auto-confirmed by the provider, so this only
gates email sign-ups and keeps the anti-bot protection intact.

You'll fill the Google and Apple panels with values produced in steps 2–3.

---

## 2. Google

### 2a. Google Cloud — OAuth consent screen + client ids
In <https://console.cloud.google.com> → APIs & Services:

1. **OAuth consent screen**: External, add app name/support email, publish (or add
   testers while in "Testing").
2. **Credentials → Create credentials → OAuth client ID**, three times:
   - **Web application** → this is the **Web client id + secret**. (Used by
     Supabase as the token audience.)
   - **iOS** → bundle id `app.vollo.mobile` → gives an **iOS client id**.
   - **Android** → package `app.vollo.mobile` + your signing-key **SHA-1**
     (`eas credentials` or `keytool -list`) → gives an **Android client id**.

### 2b. Supabase → Google provider
- **Enabled**: on.
- **Client ID (for OAuth)** / **Client Secret**: the **Web** client id + secret.
- **Authorized Client IDs**: add the **iOS** and **Android** client ids
  (comma-separated). 👈 *This is the #1 cause of "native Google sign-in fails" —
  the native id token's audience is the iOS/Android client id, and Supabase
  rejects it unless that id is listed here.*

### 2c. App config — `mobile/app.json`
| Where | Value |
| --- | --- |
| `expo.extra.googleWebClientId` | the **Web** client id |
| `expo.extra.googleIosClientId` | the **iOS** client id |
| `expo.plugins → @react-native-google-signin/google-signin → iosUrlScheme` | the **iOS** client id **reversed**, e.g. `com.googleusercontent.apps.1234-abcd` |

(Or inject `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` / `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`
at build time instead of editing `app.json`.)

The Google button appears as soon as `googleWebClientId` is non-empty.

---

## 3. Apple (iOS)

Requires a paid **Apple Developer** account. For **native iOS** the minimum is:

1. **Certificates, Identifiers & Profiles → Identifiers →** your App ID
   (`app.vollo.mobile`) → enable the **Sign In with Apple** capability.
   (`ios.usesAppleSignIn: true` in `app.json` already requests the matching
   entitlement at build time.)
2. **Supabase → Apple provider → Enabled**, and add the bundle id
   `app.vollo.mobile` to **Authorized Client IDs** — for native iOS the id
   token's audience is the bundle id, so that's all GoTrue needs to trust it.

> A **Services ID + key/secret** is only required for the web/Android Apple leg
> (the browser redirect). Native iOS sign-in via `expo-apple-authentication` does
> not need it. Vollo's Apple button is iOS-only, so you can stop at step 3.2.

Apple returns the user's name **only on the first authorization**. The app
captures it then and sets it as the display name (see `signInWithApple` in
`store/auth.ts`); afterwards the trigger's email/handle fallback applies and the
user can edit their name in-app.

---

## 4. How a new OAuth user becomes a Vollo profile

`supabase.auth.signInWithIdToken` creates an `auth.users` row that the provider
has already email-confirmed, so the `on_auth_user_created` trigger fires at once.
Migration `015`'s `handle_new_auth_user()` derives the profile from provider
metadata:

- **display name** ← `full_name` / `name` (Google), or Apple's first-consent name.
- **username** ← a slug of that name, else the email local-part (lowercased,
  `[a-z0-9_]`), else a stable `player_<id>` fallback; collisions get suffixed.
- **avatar** ← `picture` / `avatar_url` (Google).

Email sign-up is unchanged — its explicit `username` + `display_name` still win.

---

## 5. Build & verify

```bash
cd mobile
# dev client with the native modules compiled in:
eas build --profile development --platform ios      # and/or android
# then run Metro against it:
npx expo start --dev-client
```

Smoke test:
1. Google button → native account picker → lands in the app signed in.
2. Apple button (iOS) → Apple sheet → signed in; first run sets your name.
3. The new profile exists with a sensible handle/avatar:
   ```sql
   select username, display_name, email, avatar_url, auth_id
   from public.users order by created_at desc limit 5;
   ```
4. Existing username/password login and sign-up still work unchanged.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Google: *"Google did not return an identity token"* | `googleWebClientId` is wrong/blank — it must be the **Web** client id. |
| Google: sign-in succeeds on device but Supabase 401s | Add the **iOS/Android** client ids to Google → **Authorized Client IDs** in Supabase. |
| Google button missing | `googleWebClientId` empty — that's the gate. |
| Apple button missing | Not iOS, or not a native build (Expo Go), or capability not provisioned. |
| Apple: `invalid audience` | Add the bundle id `app.vollo.mobile` to Apple → **Authorized Client IDs**. |
| Display name is `player_…` | Provider sent no name (Apple after first consent, or Google name hidden) — expected; editable in-app. |
