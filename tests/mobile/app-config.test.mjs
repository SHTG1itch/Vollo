import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const config = JSON.parse(await readFile(new URL('../../mobile/app.json', import.meta.url), 'utf8')).expo;

test('mobile config blocks unused camera, microphone, and background-location access', () => {
  assert.deepEqual(config.android.permissions.sort(), ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION']);
  assert.equal(config.android.blockedPermissions.includes('android.permission.CAMERA'), true);
  assert.equal(config.android.blockedPermissions.includes('android.permission.RECORD_AUDIO'), true);

  const location = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-location')[1];
  assert.equal(location.isIosBackgroundLocationEnabled, false);
  assert.equal(location.isAndroidBackgroundLocationEnabled, false);
  assert.equal(location.isAndroidForegroundServiceEnabled, false);

  const picker = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-image-picker')[1];
  assert.equal(picker.cameraPermission, false);
  assert.equal(picker.microphonePermission, false);
});
