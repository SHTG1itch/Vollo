import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('authenticated navigation cannot bypass the current Terms gate', async () => {
  const [navigator, terms, policy] = await Promise.all([
    read('mobile/src/navigation/RootNavigator.tsx'),
    read('mobile/src/screens/TermsScreen.tsx'),
    read('mobile/src/policy/terms.ts'),
  ]);
  assert.match(navigator, /user\.terms_version !== CURRENT_TERMS_VERSION/);
  assert.match(navigator, /needsTerms \? \(/);
  assert.match(terms, /Accept Terms of Use/);
  assert.match(terms, /await acceptTerms\(CURRENT_TERMS_VERSION\)/);
  assert.match(terms, /Log out/);
  assert.match(policy, /sexually explicit/);
  assert.match(policy, /report players and content/);
  assert.match(policy, /terminate accounts/);
});

test('reports are available for every public UGC surface', async () => {
  const [report, profile, match, club, court, settings] = await Promise.all([
    read('mobile/src/screens/ReportScreen.tsx'),
    read('mobile/src/screens/ProfileScreen.tsx'),
    read('mobile/src/screens/MatchDetailScreen.tsx'),
    read('mobile/src/screens/ClubDetailScreen.tsx'),
    read('mobile/src/screens/CourtDetailScreen.tsx'),
    read('mobile/src/screens/SettingsScreen.tsx'),
  ]);
  assert.match(report, /await api\.reportContent/);
  assert.match(report, /accessibilityRole="radiogroup"/);
  assert.match(report, /Reports are confidential/);
  assert.match(profile, /subjectType: 'user'/);
  assert.match(match, /subjectType: 'match'/);
  assert.match(match, /subjectType: 'comment'/);
  assert.match(club, /subjectType: 'club'/);
  assert.match(court, /subjectType: 'court'/);
  assert.match(settings, /Terms of Use/);
});

test('Apple first-sign-in names survive the pre-consent mutation gate', async () => {
  const auth = await read('mobile/src/store/auth.ts');
  assert.match(auth, /PENDING_APPLE_NAME_KEY/);
  assert.match(auth, /authId: data\.user\.id, name: credential\.fullName/);
  assert.match(auth, /me\.terms_version !== CURRENT_TERMS_VERSION/);
  assert.match(auth, /await applyPendingAppleName\(\)/);
});
