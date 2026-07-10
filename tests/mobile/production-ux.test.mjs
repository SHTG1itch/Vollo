import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('shared form controls expose accessible semantics and touch targets', async () => {
  const [source, boundary] = await Promise.all([
    read('mobile/src/components/ui.tsx'),
    read('mobile/src/components/ErrorBoundary.tsx'),
  ]);
  assert.match(source, /accessibilityRole="button"/);
  assert.match(source, /accessibilityState=\{\{ disabled: Boolean\(disabled \|\| loading\), busy: Boolean\(loading\) \}\}/);
  assert.match(source, /accessibilityLabelledBy=\{label \? labelId : undefined\}/);
  assert.match(source, /minHeight: 44/);
  assert.match(source, /if \(pressLocked\.current \|\| disabled \|\| loading\) return/);
  assert.match(source, /setTimeout\(\(\) => \{[\s\S]*pressLocked\.current = false[\s\S]*\}, 400\)/);
  assert.match(boundary, /__DEV__/);
  assert.match(boundary, /An unexpected error occurred\. Please try again\./);
});

test('court placement uses Apple native tiles on iOS and visibly attributes OSM data', async () => {
  const source = await read('mobile/src/screens/AddCourtScreen.tsx');
  assert.doesNotMatch(source, /\bUrlTile\b[^;]*from 'react-native-maps'/);
  assert.doesNotMatch(source, /mapType="none"/);
  assert.match(source, /<MapView[\s\S]*?showsUserLocation[\s\S]*?\/>/);
  assert.match(source, /Map\/search data © OpenStreetMap contributors/);
  assert.match(source, /Search data © OpenStreetMap contributors/);
  assert.match(source, /accessibilityRole="link"/);
});

test('profile photos remain local drafts until save and all clear actions are explicit', async () => {
  const [source, uploads] = await Promise.all([
    read('mobile/src/screens/EditProfileScreen.tsx'),
    read('mobile/src/lib/uploadImage.ts'),
  ]);
  const saveStart = source.indexOf('const save = async');
  assert.ok(saveStart > 0);
  assert.ok(source.indexOf("uploadProfileImage('avatar'", saveStart) > saveStart);
  assert.ok(source.indexOf("uploadProfileImage('cover'", saveStart) > saveStart);
  assert.match(source, /body\.home = null/);
  assert.match(source, /homeCleared && hasPersistedHome\(user\)/);
  assert.match(source, /setHomeCleared\(true\)/);
  assert.match(source, /e\.status >= 400 && e\.status < 500/);
  assert.match(source, /label="Remove photo"/);
  assert.match(source, /label="Remove cover photo"/);
  assert.match(source, /label="Clear home base"/);
  assert.match(source, /Search data © OpenStreetMap contributors/);
  assert.match(source, /removeProfileImageUrl\(user\?\.avatar_url, mediaOwnerId, 'avatar'\)/);
  assert.match(source, /removeProfileImageUrl\(user\?\.cover_url, mediaOwnerId, 'cover'\)/);
  assert.match(uploads, /segments\[1\] === 'profile'/);
  assert.match(uploads, /segments\[2\]!\.startsWith\(`\$\{kind\}-`\)/);
  const profilePathAt = uploads.indexOf('const path = `${authUid}/profile/${kind}-${nonce}.jpg`');
  const registerAt = uploads.indexOf('await api.registerProfilePhotoDraft(path)', profilePathAt);
  const uploadAt = uploads.indexOf('await uploadAsset(path, asset, { upsert: false })', profilePathAt);
  assert.ok(profilePathAt > 0 && registerAt > profilePathAt);
  assert.ok(uploadAt > registerAt, 'durable cleanup must be registered before profile bytes are uploaded');
  assert.match(uploads, /discardProfileImageDraft[\s\S]*removeProfileImageObject\(uploaded\.path, uploaded\.ownerId\)[\s\S]*api\.discardProfilePhotoDraft\(uploaded\.path\)/);
  assert.match(source, /stagedMedia\.map\(\(uploaded\) => discardProfileImageDraft\(uploaded\)\)/);
});

test('match photos remain local until an idempotent match submission', async () => {
  const [source, uploads] = await Promise.all([
    read('mobile/src/screens/LogMatchScreen.tsx'),
    read('mobile/src/lib/uploadImage.ts'),
  ]);
  const submitStart = source.indexOf('const submit = async');
  assert.ok(submitStart > 0);
  const registerAt = source.indexOf('api.registerMatchPhotoDraft(matchPhotoObjectPath(photoDraft, clientKey))', submitStart);
  const uploadAt = source.indexOf('uploadMatchPhoto(photoDraft, clientKey)', submitStart);
  assert.ok(registerAt > submitStart);
  assert.ok(uploadAt > registerAt, 'durable cleanup must be registered before bytes are uploaded');
  assert.match(uploads, /pickMatchPhotoDraft\(\)[\s\S]*return \{ asset, ownerId: await getProfileMediaOwnerId\(\) \}/);
  assert.match(uploads, /return `\$\{draft\.ownerId\}\/match\/\$\{clientKey\}\.jpg`/);
  assert.match(uploads, /uploadAsset\(path, draft\.asset, \{ upsert: true \}\)/);
  assert.match(source, /submitActive\.current \|\| submitting/);
  assert.match(source, /photoMayBeCommitted\.current/);
  assert.match(source, /discardStagedMatchPhoto\(staged\)/);
});

test('password recovery is a complete in-app flow and callback credentials are consumed', async () => {
  const [app, auth, login] = await Promise.all([
    read('mobile/App.tsx'),
    read('mobile/src/store/auth.ts'),
    read('mobile/src/screens/LoginScreen.tsx'),
  ]);
  assert.match(app, /beginPasswordRecovery\(url\)/);
  assert.match(auth, /resetPasswordForEmail/);
  assert.match(auth, /updateUser\(\{ password \}\)/);
  assert.match(auth, /redirectTo: 'vollo:\/\/reset-password'/);
  assert.match(auth, /PASSWORD_RECOVERY_ACCOUNT_KEY/);
  assert.match(auth, /startupRecoveryAccount/);
  assert.match(auth, /event === 'INITIAL_SESSION'/);
  assert.match(auth, /This reset session expired/);
  assert.match(auth, /removeItem\(PASSWORD_RECOVERY_ACCOUNT_KEY\)\.catch\(\(\) => \{\}\)/);
  assert.match(login, /label="Forgot password\?"/);
});

test('settings saves stay scoped to the account that initiated them', async () => {
  const source = await read('mobile/src/screens/SettingsScreen.tsx');
  assert.match(source, /const accountId = user\.id/g);
  assert.match(source, /current\?\.id === accountId/g);
  assert.match(source, /accessibilityLabel="Private account"/);
  assert.match(source, /accessibilityLabel="Territory and leaderboard visibility"/);
});

test('transient session refresh failures never sign the user out', async () => {
  const [client, auth] = await Promise.all([
    read('mobile/src/api/client.ts'),
    read('mobile/src/store/auth.ts'),
  ]);
  assert.match(client, /type SessionRefreshResult = string \| null \| undefined/);
  assert.match(client, /\.catch\(\(\) => undefined\)/);
  assert.match(client, /if \(fresh === undefined\)[\s\S]*auth_unavailable/);
  assert.ok(
    client.indexOf('if (fresh === undefined)') < client.indexOf('onUnauthorized?.(generation)'),
    'a transient refresh must exit before destructive unauthorized handling',
  );
  assert.match(auth, /const definitelyInvalid = status >= 400 && status < 500 && status !== 429/);
  assert.match(auth, /return definitelyInvalid \? null : undefined/);
  assert.match(auth, /HYDRATION_TIMEOUT_MS = 10_000/);
  assert.match(auth, /hydrationWatchdog = setTimeout/);
  assert.match(auth, /Saved sign-in took too long to restore/);
  assert.match(auth, /clearTimeout\(hydrationWatchdog\)/);
});

test('the authenticated navigation tree is isolated per account', async () => {
  const [auth, navigator, settings] = await Promise.all([
    read('mobile/src/store/auth.ts'),
    read('mobile/src/navigation/RootNavigator.tsx'),
    read('mobile/src/screens/SettingsScreen.tsx'),
  ]);
  assert.match(auth, /accountId: string \| null/);
  assert.match(auth, /useAuth\.setState\(\{ token, accountId, user: null, meError: false \}\)/);
  assert.match(navigator, /navigationKey=\{accountId \?\? 'authenticated'\}/);
  assert.match(settings, /label="Edit profile"[^>]*disabled=\{!user\}/);
});

test('creation screens synchronously reject rapid duplicate taps', async () => {
  const [court, schedule, club, goals] = await Promise.all([
    read('mobile/src/screens/AddCourtScreen.tsx'),
    read('mobile/src/screens/ScheduleMatchScreen.tsx'),
    read('mobile/src/screens/CreateClubScreen.tsx'),
    read('mobile/src/screens/GoalsScreen.tsx'),
  ]);
  assert.match(court, /submitActive\.current \|\| submitting/);
  assert.match(court, /client_key: requestKey/);
  assert.match(schedule, /saveActive\.current \|\| saving/);
  assert.match(schedule, /client_key: requestKey/);
  assert.match(club, /saveActive\.current \|\| saving/);
  assert.match(club, /const requestKey = useRef\(newClientKey\(\)\)\.current/);
  assert.match(club, /client_key: requestKey/);
  assert.match(goals, /saveActive\.current \|\| saving/);
});

test('comments reject rapid duplicates and activity links use validated navigation', async () => {
  const [match, notifications, nav] = await Promise.all([
    read('mobile/src/screens/MatchDetailScreen.tsx'),
    read('mobile/src/screens/NotificationsScreen.tsx'),
    read('mobile/src/navigation/ref.ts'),
  ]);
  assert.match(match, /commentInFlight\.current/);
  assert.match(match, /if \(!draft\.trim\(\) \|\| !user \|\| commentInFlight\.current\) return/);
  assert.match(notifications, /navigateFromPush\(data\)/);
  assert.match(notifications, /typeof data\?\.username === 'string'/);
  assert.match(nav, /USERNAME_RE\.test\(username\)/);
});
