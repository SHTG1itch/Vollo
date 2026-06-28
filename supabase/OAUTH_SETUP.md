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

## Live status (Google: fully set up 2026-06-27, button enabled 2026-06-28)

**Google sign-in is configured, published, Android-ready, and the button is now ON. Nothing left in the consoles — just build & install a dev client.**

| Done | Detail |
| --- | --- |
| Google Cloud project | **Vollo** (`stable-course-500806-f0`), owner `you@example.com` |
| OAuth consent screen | App "Vollo", External, **published to Production** (basic scopes → no verification needed) |
| Web OAuth client | **Vollo Web** — `958415288431-fol1pk22asmc748feuvbo1gkntcegis2.apps.googleusercontent.com`; redirect URI = the Supabase callback |
| Android OAuth client | **Vollo Android** — `958415288431-ui589sqprbac8v4e87h1f143m5qq5gtu.apps.googleusercontent.com`; package `app.vollo.mobile`, SHA-1 `9B:1A:88:97:8F:1B:29:D4:0E:CA:8A:75:EC:F8:65:27:8C:2D:CF:D9` (EAS `development` keystore) |
| Supabase Google provider | **Enabled** with the Web client id + secret (verified live: `GET /auth/v1/settings` → `external.google: true`) |
| App config | `expo.extra.googleWebClientId` set in `mobile/app.json`; **`googleAuthEnabled: true`** (master switch ON → button shown); EAS project linked (`eas.json` + `extra.eas.projectId`) |
| DB provisioning | Migration `015`'s `handle_new_auth_user()` confirmed live and proven end-to-end against the project (simulated Google identity → `public.users` row with derived handle/display/avatar + `user_streaks`, collisions suffixed; email sign-up's explicit username/display\_name still win) |

**To use it:** build & install the Android dev client signed with that same
keystore, then tap "Continue with Google":

```bash
cd mobile
eas build -p android --profile development   # uses the SHA-1 above
```

> **The Google button only works in this dev/standalone build — never in Expo
> Go.** `@react-native-google-signin/google-signin` is a native module that
> Expo Go doesn't bundle, so the button is hidden in Expo Go (tapping it there
> would otherwise throw *"Cannot read property 'GoogleSignin' of undefined"*).
>
> **Build prerequisites (already set in this repo — here so the build stays
> reproducible):**
> - **`expo.newArchEnabled: true`** in `app.json`. `react-native-reanimated` 4
>   and `@shopify/flash-list` 2 are New-Architecture-only; `react-native-worklets`
>   fails the Android build at preBuild with `GradleException("[Worklets]
>   Worklets require new architecture to be enabled")` if it's false. Expo Go
>   (SDK 54) always runs the New Architecture and ignores this flag — which is
>   why the app runs there but an old-arch custom build fails.
> - **`expo-dev-client`** must be installed (it is, in `package.json`) because
>   the `development` EAS profile sets `developmentClient: true`.
>
> After the build installs, native sign-in additionally needs the **Android
> OAuth client** (package `app.vollo.mobile` + the dev keystore SHA-1, already
> created) — a missing/mismatched SHA-1 gives a runtime `DEVELOPER_ERROR`, not a
> build failure.

If you ever build with a **different** keystore (e.g. a `preview`/`production`
profile, or a new dev keystore), add that keystore's SHA-1 as another **Android**
OAuth client in the Vollo project (§2d), or Google returns `DEVELOPER_ERROR`.

**Apple sign-in is intentionally not set up** — Sign In with Apple requires the
Apple Developer Program ($99/yr), which conflicts with the $0 constraint. The
Apple button stays hidden automatically; revisit §3 only if you ever pay for that
program.

---

## 1. Supabase dashboard (both providers)

Authentication → **Providers**. Leave **email confirmation ON** (Authentication →
Providers → Email) — OAuth users are auto-confirmed by the provider, so this only
gates email sign-ups and keeps the anti-bot protection intact.

You'll fill the Google and Apple panels with values produced in steps 2–3.

---

## 2. Google

> **§2a–2c are already done** (see "Live status" above) — the Web client exists,
> Supabase is configured, and `app.json` is set. The only outstanding piece is the
> **Android** client in **§2d**. §2a–2c remain here for reference / disaster recovery.

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

The Google button appears once `googleWebClientId` is non-empty **and** the
`expo.extra.googleAuthEnabled` master switch is `true` (its default). Set that
switch to `false` — or build with `EXPO_PUBLIC_GOOGLE_AUTH=0` — to hide the
button for email-only testing without dropping the configured client id; the
Google Cloud / Supabase setup stays untouched either way.

### 2d. Android OAuth client (the remaining step) — needs your SHA-1
Android sign-in only works if the Vollo project has an **Android** OAuth client
whose package + SHA-1 match the installed app. To get the SHA-1 from your EAS
build keystore (free):

```bash
cd mobile
npx eas-cli credentials        # Android → Keystore → shows SHA-1 / SHA1 Fingerprint
# (or `eas build -p android --profile development` once, then re-run credentials)
```

Then in Google Cloud → **Vollo** project → **Clients → Create OAuth client**:
- Application type: **Android**
- Package name: `app.vollo.mobile`
- SHA-1 certificate fingerprint: *(paste the value from above)*

No app.json change is needed for Android — the runtime uses `googleWebClientId`
as the token audience; the Android client just has to exist so Google trusts the
calling app. (If you build multiple variants — dev/preview/production — add each
variant's SHA-1, since they can use different keystores.)

---

## 3. Apple (iOS) — deferred (not free)

> Skipped under the $0 constraint: Sign In with Apple requires the **Apple
> Developer Program ($99/yr)**. The Apple button stays hidden until both a native
> iOS build and the steps below exist. Do this only if you later pay for that
> program.

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

> **Already verified against the live project (2026-06-28):** the Supabase
> Google provider is enabled (`external.google: true`) and the migration-`015`
> provisioning trigger was exercised end-to-end by inserting simulated Google
> identities into `auth.users` (auto-confirmed, provider metadata only). Each
> produced a `public.users` row with a sensible handle/display/avatar and a
> `user_streaks` row; a colliding handle was suffixed; and an email sign-up's
> explicit `username`/`display_name` still won. All runs were rolled back, so
> nothing persisted. The remaining device-only leg — native account picker →
> ID token → Supabase session — needs an EAS dev build (the native module isn't
> in Expo Go), so smoke-test steps 1–3 on a real build.

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
