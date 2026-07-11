import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const config = JSON.parse(await readFile(new URL('../../mobile/app.json', import.meta.url), 'utf8')).expo;
const eas = JSON.parse(await readFile(new URL('../../mobile/eas.json', import.meta.url), 'utf8'));
const require = createRequire(import.meta.url);
const dynamicConfig = require('../../mobile/app.config.js');

test('production builds use an exact validated EAS CLI contract', () => {
  assert.match(eas.cli.version, /^\d+\.\d+\.\d+$/);
  assert.equal(eas.cli.version, '20.5.1');
  assert.equal(eas.cli.appVersionSource, 'remote');
  assert.equal(eas.build.production.autoIncrement, true);
});

test('mobile config blocks unused camera, microphone, and background-location access', () => {
  assert.equal(config.android.allowBackup, false);
  assert.equal(config.ios.config.usesNonExemptEncryption, false);
  assert.deepEqual(config.android.permissions.sort(), ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION']);
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
  const enabled = dynamicConfig({
    config: { ...config, extra: { ...config.extra, appleAuthEnabled: true } },
  });
  assert.equal(enabled.ios.usesAppleSignIn, true);
  assert.equal(enabled.plugins.includes('expo-apple-authentication'), true);
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
