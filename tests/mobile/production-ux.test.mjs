import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

async function tsxFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? tsxFiles(target) : entry.name.endsWith('.tsx') ? [target] : [];
  }));
  return nested.flat();
}

// Extract JSX opening tags without mistaking the `>` in an arrow-function
// attribute for the end of the tag. This keeps the accessibility audit
// dependency-free so it runs before the mobile npm install in CI.
function pressableOpeningTags(source) {
  const tags = [];
  let start = source.indexOf('<Pressable');
  while (start !== -1) {
    let braces = 0;
    let quote = null;
    let escaped = false;
    for (let index = start + '<Pressable'.length; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '{') braces += 1;
      else if (char === '}') braces -= 1;
      else if (char === '>' && braces === 0) {
        tags.push({ source: source.slice(start, index + 1), offset: start });
        break;
      }
    }
    start = source.indexOf('<Pressable', start + 1);
  }
  return tags;
}

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

test('every interactive Pressable exposes an accessibility role', async () => {
  const sourceRoot = fileURLToPath(new URL('../../mobile/src/', import.meta.url));
  const files = await tsxFiles(sourceRoot);
  const missing = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const tag of pressableOpeningTags(source)) {
      if (!/\baccessibilityRole=/.test(tag.source)) {
        const line = source.slice(0, tag.offset).split('\n').length;
        missing.push(`${path.relative(sourceRoot, file)}:${line}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('user-visible mobile copy contains no mojibake', async () => {
  const sourceRoot = fileURLToPath(new URL('../../mobile/src/', import.meta.url));
  const files = await tsxFiles(sourceRoot);
  const malformed = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    source.split(/\r?\n/).forEach((line, index) => {
      if (/[\u00c2\u00c3\u00e2]/u.test(line)) {
        malformed.push(`${path.relative(sourceRoot, file)}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(malformed, []);
});

test('quickstart pages avoid Android carousel recycling artifacts', async () => {
  const source = await read('mobile/src/screens/QuickstartScreen.tsx');
  assert.doesNotMatch(source, /\bFlatList\b|removeClippedSubviews|pagingEnabled/);
  assert.match(source, /const item = PAGES\[page\]!/);
  assert.match(source, /setPage\(\(current\) => current \+ 1\)/);
  assert.match(source, /page: \{ flex: 1,/);
});

test('empty winners-versus-errors charts keep a neutral track', async () => {
  const source = await read('mobile/src/components/charts.tsx');
  assert.match(source, /const total = positive \+ negative;/);
  assert.match(source, /const posPct = total > 0 \?/);
  assert.match(source, /\{total > 0 \? \(/);
  assert.doesNotMatch(source, /positive \+ negative \|\| 1/);
});

test('player search flexes the field container without collapsing its input', async () => {
  const source = await read('mobile/src/screens/UserSearchScreen.tsx');
  assert.match(source, /<View style=\{\{ flex: 1 \}\}>\s*<Field/);
  const field = source.match(/<Field[\s\S]*?maxLength=\{60\}[\s\S]*?\/>/)?.[0];
  assert.ok(field);
  assert.doesNotMatch(field, /style=\{\{ flex: 1 \}\}/);
});

test('challenge actions do not advertise an unavailable past slot', async () => {
  const source = await read('mobile/src/screens/ScheduleMatchScreen.tsx');
  assert.match(source, /availableHours\.length === 0\s*\? 'Choose another day'/);
  assert.match(source, /disabled=\{!hasOpponent \|\| availableHours\.length === 0 \|\| inPast\}/);
  assert.match(source, /<Button label=\{actionLabel\}/);
});

test('trophy-case match counts use singular copy for one match', async () => {
  const source = await read('mobile/src/screens/RecordsScreen.tsx');
  assert.match(source, /count === 1 \? 'match' : 'matches'/);
  assert.match(source, /value: matchCountLabel\(records\.busiest_month\.matches\)/);
  assert.match(source, /`\$\{matchCountLabel\(records\.total_matches\)\} logged`/);
});

test('season-recap highlights pluralize match counts', async () => {
  const source = await read('mobile/src/screens/YearInReviewScreen.tsx');
  assert.match(source, /count === 1 \? 'match' : 'matches'/);
  assert.match(source, /matchCountLabel\(review\.top_opponent\.matches\)/);
  assert.match(source, /matchCountLabel\(review\.favorite_court\.matches\)/);
  assert.match(source, /matchCountLabel\(review\.favorite_surface\.matches\)/);
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

test('map preserves partial overlay results and makes primary load failures retryable', async () => {
  const source = await read('mobile/src/screens/MapScreen.tsx');
  assert.match(source, /Promise\.allSettled\(\[/);
  assert.match(source, /territoryResult\.status === 'fulfilled'[\s\S]*commitTerritories/);
  assert.match(source, /courtResult\.status === 'fulfilled'[\s\S]*commitCourts/);
  assert.match(source, /setOverlayLoadError\(territoryResult\.status === 'rejected' \|\| courtResult\.status === 'rejected'\)/);
  assert.match(source, /accessibilityLabel="Retry loading map data"/);
  assert.match(source, /load\(lastRegion\.current, \{ force: true \}\)/);
});

test('user-triggered location failures are visible instead of silent', async () => {
  const [addCourt, map] = await Promise.all([
    read('mobile/src/screens/AddCourtScreen.tsx'),
    read('mobile/src/screens/MapScreen.tsx'),
  ]);
  const message = /Could not get your location\. Check location services and try again\./;
  assert.match(addCourt, message);
  assert.match(map, message);
  assert.doesNotMatch(addCourt, /const recenter = async \(\) => \{[\s\S]*?catch \{\s*\/\* ignore \*\//);
  assert.doesNotMatch(map, /const recenter = useCallback\(async \(\) => \{[\s\S]*?catch \{\s*\/\* keep current view \*\//);
});

test('location lookups do not repeatedly reopen the Android settings sheet', async () => {
  const sources = await Promise.all([
    read('mobile/src/screens/AddCourtScreen.tsx'),
    read('mobile/src/screens/CourtsScreen.tsx'),
    read('mobile/src/screens/MapScreen.tsx'),
    read('mobile/src/screens/LogMatchScreen.tsx'),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /getCurrentPositionAsync\(\{\}\)/);
    for (const call of source.matchAll(/getCurrentPositionAsync\(([^)]*)\)/g)) {
      assert.match(call[1], /mayShowUserSettingsDialog: false/);
    }
  }
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

test('optional native cold-start lookups cannot reject unhandled', async () => {
  const app = await read('mobile/App.tsx');
  assert.match(app, /getLastNotificationResponseAsync\(\)\.then\([\s\S]*?\)\.catch\(\(\) => \{/);
  assert.match(app, /Linking\.getInitialURL\(\)\.then\([\s\S]*?\)\.catch\(\(\) => \{/);
});

test('privacy stays available offline throughout account setup and settings', async () => {
  const [navigator, login, register, settings, terms, privacy] = await Promise.all([
    read('mobile/src/navigation/RootNavigator.tsx'),
    read('mobile/src/screens/LoginScreen.tsx'),
    read('mobile/src/screens/RegisterScreen.tsx'),
    read('mobile/src/screens/SettingsScreen.tsx'),
    read('mobile/src/screens/TermsScreen.tsx'),
    read('mobile/src/screens/PrivacyScreen.tsx'),
  ]);
  assert.match(navigator, /name="Privacy" component=\{PrivacyScreen\}/);
  for (const source of [login, register, settings, terms]) {
    assert.match(source, /label="Privacy Policy"/);
    assert.match(source, /navigation\.navigate\('Privacy'\)/);
  }
  assert.match(privacy, /PRIVACY_SECTIONS\.map/);
  assert.match(privacy, /Effective \{PRIVACY_EFFECTIVE_DATE\}/);
});

test('external attribution links report native launch failures', async () => {
  const sources = await Promise.all([
    read('mobile/src/screens/AddCourtScreen.tsx'),
    read('mobile/src/screens/EditProfileScreen.tsx'),
    read('mobile/src/screens/MapScreen.tsx'),
  ]);
  for (const source of sources) {
    assert.match(
      source,
      /Linking\.openURL\('https:\/\/www\.openstreetmap\.org\/copyright'\)\s*\.catch\(\(\) => showToast\('Could not open the OpenStreetMap attribution\.', 'error'\)\)/,
    );
  }
});

test('settings saves stay scoped to the account that initiated them', async () => {
  const source = await read('mobile/src/screens/SettingsScreen.tsx');
  assert.match(source, /const accountId = user\.id/g);
  assert.match(source, /current\?\.id === accountId/g);
  assert.match(source, /accessibilityLabel="Private account"/);
  assert.match(source, /accessibilityLabel="Territory and leaderboard visibility"/);
});

test('privacy relationship queues distinguish load failures from an empty queue', async () => {
  const [settings, notifications] = await Promise.all([
    read('mobile/src/screens/SettingsScreen.tsx'),
    read('mobile/src/screens/NotificationsScreen.tsx'),
  ]);
  assert.match(settings, /setBlockedError\('Could not load blocked players\.'\)/);
  assert.match(settings, /blockedError[\s\S]*label="Try again"[\s\S]*onPress=\{loadBlockedUsers\}/);
  assert.doesNotMatch(settings, /getBlockedUsers\(\)[\s\S]{0,120}\.catch\(\(\) => \{\}\)/);
  assert.match(notifications, /setRequestsError\('Could not load follow requests\.'\)/);
  assert.match(notifications, /error=\{requestsError\}/);
  assert.match(notifications, /onRetry=\{\(\) => void loadFollowRequests\(\)\}/);
  assert.doesNotMatch(notifications, /getFollowRequests\(\)[\s\S]{0,160}\.catch\(\(\) => \{\}\)/);
  assert.match(
    notifications,
    /onRefresh=\{\(\) => \{\s*void fetch\(true\);\s*void loadFollowRequests\(\);/,
  );
});

test('match opponent lookup distinguishes search failure from no registered player', async () => {
  const source = await read('mobile/src/screens/LogMatchScreen.tsx');
  assert.match(source, /setOppSearchError\(true\)/);
  assert.match(source, /Player search is unavailable\. Try again before logging if this opponent uses Vollo\./);
  assert.match(source, /label="Retry player search"[\s\S]*onPress=\{\(\) => searchOpponents\(opponentName\)\}/);
  assert.doesNotMatch(source, /if \(query\.length < 2 \|\| opponentId\)/);
});

test('route-prefilled courts are visible before selection and remain retryable', async () => {
  const source = await read('mobile/src/screens/LogMatchScreen.tsx');
  assert.match(source, /const loadCourtIntoPicker = useCallback/);
  assert.match(source, /setCourts\([\s\S]*setCourtId\(court\.id\)/);
  assert.match(source, /if \(p\.prefillCourtId\) setCourtId\(null\)/);
  assert.doesNotMatch(source, /if \(p\.prefillCourtId\) setCourtId\(p\.prefillCourtId\)/);
  assert.match(source, /accessibilityLabel="Retry loading selected court"/);
  assert.match(source, /courtLookupToken\.current \+= 1;[\s\S]*setCourtId\(null\)/);
  assert.match(source, /courtLookupLoading \|\| !canSubmitLogMatch/);
  assert.match(source, /Wait for the selected court to finish loading before logging\./);
});

test('failed optimistic social actions visibly revert instead of failing silently', async () => {
  const [search, club, match, feed] = await Promise.all([
    read('mobile/src/screens/UserSearchScreen.tsx'),
    read('mobile/src/screens/ClubDetailScreen.tsx'),
    read('mobile/src/screens/MatchDetailScreen.tsx'),
    read('mobile/src/store/feed.ts'),
  ]);
  assert.match(search, /patchResult\(u\.id, was\);\s*showToast\('Could not update this follow/);
  assert.match(club, /Could not update kudos — please try again\./);
  assert.match(match, /Could not update kudos — please try again\./);
  assert.match(feed, /applyDelta\(wasKudosed\);\s*showToast\('Could not update kudos/);
  assert.match(feed, /Could not load more matches — please try again\./);
});

test('partial profile and club failures are not misreported as empty sections', async () => {
  const [profile, club] = await Promise.all([
    read('mobile/src/screens/ProfileScreen.tsx'),
    read('mobile/src/screens/ClubDetailScreen.tsx'),
  ]);
  assert.match(profile, /setSectionsError\(\[a, r, ach, st, terr, hh, feed, gl\]\.some/);
  assert.match(profile, /Some profile details couldn&apos;t refresh\. Pull down to try again\./);
  assert.match(club, /else setLeaderboardError\(true\)/);
  assert.match(club, /else setFeedError\(true\)/);
  assert.match(club, /Couldn&apos;t refresh the club leaderboard/);
  assert.match(club, /feedError \? \([\s\S]*Couldn&apos;t refresh recent club matches/);
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

test('logout gives push-token removal a bounded authenticated completion window', async () => {
  const [auth, client, push] = await Promise.all([
    read('mobile/src/store/auth.ts'),
    read('mobile/src/api/client.ts'),
    read('mobile/src/services/push.ts'),
  ]);
  assert.match(push, /function takeRegisteredPushToken[\s\S]*lastRegisteredToken = null/);
  assert.match(client, /sendWithTokenSnapshot[\s\S]*const token = authToken/);
  assert.match(auth, /const unregister = pushToken[\s\S]*api\.unregisterPushToken\(pushToken\)/);
  assert.ok(auth.indexOf('applySession(null, null)') < auth.indexOf('Promise.race(['));
  assert.match(auth, /new Promise<void>\(\(resolve\) => setTimeout\(resolve, 2_000\)\)/);
  assert.ok(auth.indexOf('Promise.race([') < auth.indexOf('supabase.auth.signOut()'));
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

test('paired responses and refreshable lists are race-safe', async () => {
  const [clubs, goals, notifications, scheduled] = await Promise.all([
    read('mobile/src/screens/ClubsScreen.tsx'),
    read('mobile/src/screens/GoalsScreen.tsx'),
    read('mobile/src/screens/NotificationsScreen.tsx'),
    read('mobile/src/screens/ScheduledMatchesScreen.tsx'),
  ]);
  assert.match(clubs, /const sequence = \+\+searchSequence\.current/);
  assert.match(clubs, /if \(sequence !== searchSequence\.current\) return/);
  assert.match(clubs, /searchSequence\.current \+= 1/);
  assert.match(goals, /const sequence = \+\+loadSequence\.current/);
  assert.match(goals, /if \(sequence !== loadSequence\.current\) return/);
  assert.match(notifications, /if \(responseActive\.current \|\| busy\) return/);
  assert.match(scheduled, /const sequence = \+\+loadSequence\.current/);
  assert.match(scheduled, /if \(responseActive\.current \|\| busyId\) return/);
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

test('training log renders deterministic seven-column calendar rows', async () => {
  const trainingLog = await read('mobile/src/screens/TrainingLogScreen.tsx');
  assert.match(trainingLog, /Array\.from\(\{ length: cells\.length \/ 7 \}/);
  assert.match(trainingLog, /cells\.slice\(row \* 7, row \* 7 \+ 7\)/);
  assert.match(trainingLog, /gridRow: \{ flexDirection: 'row' \}/);
  assert.match(trainingLog, /cell: \{ flex: 1,/);
  assert.doesNotMatch(trainingLog, /flexWrap: 'wrap'/);
  assert.doesNotMatch(trainingLog, /width: `\$\{100 \/ 7\}%`/);
});
