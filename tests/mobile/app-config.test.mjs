import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const config = JSON.parse(await readFile(new URL('../../mobile/app.json', import.meta.url), 'utf8')).expo;
const eas = JSON.parse(await readFile(new URL('../../mobile/eas.json', import.meta.url), 'utf8'));
const mobilePackage = JSON.parse(await readFile(new URL('../../mobile/package.json', import.meta.url), 'utf8'));
const mobileLock = JSON.parse(await readFile(new URL('../../mobile/package-lock.json', import.meta.url), 'utf8'));
const mobileTsconfig = JSON.parse(await readFile(new URL('../../mobile/tsconfig.json', import.meta.url), 'utf8'));
const fontLicense = await readFile(new URL('../../mobile/assets/fonts/OFL.txt', import.meta.url), 'utf8');
const rootReadme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
const privacyPolicy = await readFile(new URL('../../PRIVACY.md', import.meta.url), 'utf8');
const securityPolicy = await readFile(new URL('../../SECURITY.md', import.meta.url), 'utf8');
const oauthSetup = await readFile(new URL('../../supabase/OAUTH_SETUP.md', import.meta.url), 'utf8');
const pushService = await readFile(new URL('../../mobile/src/services/push.ts', import.meta.url), 'utf8');
const productionCapabilities = await readFile(
  new URL('../../mobile/plugins/with-production-capabilities.js', import.meta.url),
  'utf8',
);
const clipboardPatch = await readFile(
  new URL('../../scripts/patch-expo-clipboard.mjs', import.meta.url),
  'utf8',
);
const require = createRequire(import.meta.url);
const dynamicConfig = require('../../mobile/app.config.js');

test('production builds use an exact validated EAS CLI contract', () => {
  assert.match(eas.cli.version, /^\d+\.\d+\.\d+$/);
  assert.equal(eas.cli.version, '20.5.1');
  assert.equal(eas.cli.appVersionSource, 'remote');
  assert.equal(eas.build.production.autoIncrement, true);
  assert.equal(eas.build.github.extends, 'production');
  assert.equal(eas.build.github.distribution, 'internal');
  assert.equal(eas.build.github.android.buildType, 'apk');
});

test('the public Android release is documented with integrity and privacy guidance', () => {
  assert.match(rootReadme, /releases\/download\/v0\.1\.0-android\.11\/Vollo-0\.1\.0-android-v11\.apk/);
  assert.match(rootReadme, /9BE52E886335B76B5F131D6046FE1A44CCD75A2678D245A7F0E9977794ACA40F/);
  assert.match(rootReadme, /\[Privacy Policy\]\(PRIVACY\.md\)/);
  assert.match(rootReadme, /\[Security Policy\]\(SECURITY\.md\)/);
  assert.match(privacyPolicy, /Settings → Delete account/);
  assert.match(securityPolicy, /private vulnerability report/);
  assert.doesNotMatch(oauthSetup, /@gmail\.com/i);
});

test('production config advertises only supported native platforms', () => {
  assert.deepEqual(config.platforms, ['ios', 'android']);
  assert.equal(mobilePackage.scripts.web, undefined);
});

test('mobile config blocks unused camera, microphone, and background-location access', () => {
  assert.equal(config.android.allowBackup, false);
  assert.equal(config.ios.config.usesNonExemptEncryption, false);
  assert.deepEqual(config.android.blockedPermissions.sort(), [
    'android.permission.CAMERA',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.RECORD_AUDIO',
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.WRITE_EXTERNAL_STORAGE',
  ]);

  const location = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-location')[1];
  assert.equal(location.isIosBackgroundLocationEnabled, false);
  assert.equal(location.isAndroidBackgroundLocationEnabled, false);
  assert.equal(location.isAndroidForegroundServiceEnabled, false);

  const picker = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker')[1];
  assert.equal(picker.cameraPermission, false);
  assert.equal(picker.microphonePermission, false);

  const secureStore = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-secure-store');
  assert.deepEqual(secureStore, ['expo-secure-store', { configureAndroidBackup: true }]);
  assert.equal(config.extra.androidRemotePushEnabled, false);
  assert.ok(pushService.indexOf('if (!remotePushEnabled()) return') < pushService.indexOf('requestPermissionsAsync()'));
  assert.match(pushService, /Platform\.OS !== 'android'[\s\S]*androidRemotePushEnabled === true/);
});

test('Android image cropping is pinned to the security-fixed native release', () => {
  assert.match(productionCapabilities, /SECURE_CROPPER_VERSION = '4\.7\.0'/);
  assert.match(productionCapabilities, /CROPPER_ACTIVITY = 'com\.canhub\.cropper\.CropImageActivity'/);
  assert.match(productionCapabilities, /cropper\.\$\['android:exported'\] = 'false'/);
  assert.match(productionCapabilities, /resolutionStrategy\.force '\$\{marker\}'/);
});

test('Android clipboard images use delegated URI access', () => {
  assert.equal(mobilePackage.scripts.postinstall, 'node ../scripts/patch-expo-clipboard.mjs');
  assert.deepEqual(mobilePackage.expo.autolinking.android.buildFromSource, ['expo-clipboard']);
  assert.match(clipboardPatch, /assert\.equal\(packageJson\.version, '8\.0\.8'/);
  assert.match(clipboardPatch, /android:exported=\"false\"/);
  assert.match(clipboardPatch, /android:grantUriPermissions=\"true\"/);
  assert.match(clipboardPatch, /ClipboardFileProvider must be exported/);
  assert.match(productionCapabilities, /CLIPBOARD_PROVIDER = 'expo\.modules\.clipboard\.ClipboardFileProvider'/);
});

test('the declared system appearance has its required native implementation', () => {
  assert.equal(config.userInterfaceStyle, 'light');
  assert.match(mobilePackage.dependencies['expo-system-ui'], /^~6\.0\./);
});

test('mobile type-checking rejects unchecked array access', () => {
  assert.equal(mobileTsconfig.compilerOptions.strict, true);
  assert.equal(mobileTsconfig.compilerOptions.noUncheckedIndexedAccess, true);
});

test('bundled Barlow fonts retain their required open-font license', () => {
  assert.match(fontLicense, /Copyright 2017 The Barlow Project Authors/);
  assert.match(fontLicense, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(fontLicense, /provided that each copy\s+contains the above copyright notice and this license/);
});

test('the lockfile contains optional peers required by the EAS npm version', () => {
  assert.equal(mobileLock.packages['node_modules/@emnapi/core'].optional, true);
  assert.equal(mobileLock.packages['node_modules/@emnapi/runtime'].optional, true);
});

test('Google iOS configuration never ships a placeholder URL scheme', () => {
  assert.doesNotMatch(JSON.stringify(config), /REPLACE_WITH|PLACEHOLDER/i);
  assert.equal(
    config.plugins.some((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === '@react-native-google-signin/google-signin'),
    false,
  );

  const clientId = '123456-example.apps.googleusercontent.com';
  const resolved = dynamicConfig({
    config: { ...config, extra: { ...config.extra, googleIosClientId: clientId } },
  });
  const plugin = resolved.plugins.find((entry) => Array.isArray(entry) && entry[0] === '@react-native-google-signin/google-signin');
  assert.deepEqual(plugin, [
    '@react-native-google-signin/google-signin',
    { iosUrlScheme: 'com.googleusercontent.apps.123456-example' },
  ]);
  assert.throws(
    () => dynamicConfig({ config: { ...config, extra: { ...config.extra, googleIosClientId: 'placeholder' } } }),
    /valid .*apps\.googleusercontent\.com client id/,
  );
});

test('unprovisioned Apple auth is disabled and email callbacks use PKCE', async () => {
  const [oauth, auth, supabase] = await Promise.all([
    readFile(new URL('../../mobile/src/lib/oauth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../mobile/src/store/auth.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../mobile/src/lib/supabase.ts', import.meta.url), 'utf8'),
  ]);
  assert.equal(config.extra.appleAuthEnabled, false);
  const disabled = dynamicConfig({ config });
  assert.equal(disabled.ios.usesAppleSignIn, false);
  assert.equal(disabled.plugins.includes('expo-apple-authentication'), false);
  assert.deepEqual(disabled.plugins[0], [
    './plugins/with-production-capabilities',
    { appleEnabled: false, backgroundLocationEnabled: false },
  ]);
  const enabled = dynamicConfig({
    config: { ...config, extra: { ...config.extra, appleAuthEnabled: true } },
  });
  assert.equal(enabled.ios.usesAppleSignIn, true);
  assert.equal(enabled.plugins.includes('expo-apple-authentication'), true);
  assert.deepEqual(enabled.plugins[0], [
    './plugins/with-production-capabilities',
    { appleEnabled: true, backgroundLocationEnabled: false },
  ]);
  assert.match(oauth, /if \(!APPLE_AUTH_ENABLED \|\| Platform\.OS !== 'ios'\) return false/);
  assert.match(oauth, /CryptoDigestAlgorithm\.SHA256/);
  assert.match(oauth, /nonce: hashedNonce/);
  assert.match(auth, /provider: 'apple',[\s\S]*nonce: credential\.nonce/);
  assert.match(supabase, /flowType: 'pkce'/);
});

test('release API and auth transports require HTTPS', async () => {
  const [apiConfig, supabase] = await Promise.all([
    readFile(new URL('../../mobile/src/api/config.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../mobile/src/lib/supabase.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(apiConfig, /!__DEV__ && parsed\.protocol !== 'https:'/);
  assert.match(apiConfig, /\.replace\(\/\\\/\+\$\/, ''\)/);
  assert.match(supabase, /!__DEV__ && parsedSupabaseUrl\.protocol !== 'https:'/);
});
