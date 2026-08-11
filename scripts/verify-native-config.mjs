import assert from 'node:assert/strict';

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  assert.ok(size <= 5 * 1024 * 1024, 'Expo introspection output exceeded 5 MiB');
  chunks.push(chunk);
}

let config;
try {
  config = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch {
  throw new Error('Expo introspection did not return valid JSON');
}

const ios = config?._internal?.modResults?.ios;
const android = config?._internal?.modResults?.android;
assert.ok(ios?.infoPlist && ios?.entitlements, 'Expo introspection omitted iOS native results');
assert.ok(android?.manifest?.manifest, 'Expo introspection omitted Android native results');
assert.equal(typeof ios.infoPlist.NSLocationWhenInUseUsageDescription, 'string');
assert.equal(typeof ios.infoPlist.NSPhotoLibraryUsageDescription, 'string');
assert.equal(ios.infoPlist.NSPhotoLibraryAddUsageDescription, undefined);
assert.equal(ios.infoPlist.NSLocationAlwaysUsageDescription, undefined);
assert.equal(ios.infoPlist.NSLocationAlwaysAndWhenInUseUsageDescription, undefined);
assert.equal(ios.infoPlist.NSCameraUsageDescription, undefined);
assert.equal(ios.infoPlist.NSMicrophoneUsageDescription, undefined);
assert.equal(ios.entitlements['com.apple.developer.applesignin'], undefined);
assert.equal(ios.infoPlist.ITSAppUsesNonExemptEncryption, false);
assert.equal(typeof ios.entitlements['aps-environment'], 'string');
const urlSchemes = (ios.infoPlist.CFBundleURLTypes ?? [])
  .flatMap((entry) => entry.CFBundleURLSchemes ?? []);
assert.equal(urlSchemes.includes('vollo'), true);
assert.equal(urlSchemes.some((scheme) => /placeholder|replace_with/i.test(scheme)), false);
assert.equal(
  Array.isArray(ios.infoPlist.UIBackgroundModes)
    && ios.infoPlist.UIBackgroundModes.includes('location'),
  false,
);

const androidPermissions = android.manifest.manifest['uses-permission'] ?? [];
const permissionByName = new Map(
  androidPermissions.map((entry) => [entry?.$?.['android:name'], entry?.$]),
);
for (const permission of [
  'android.permission.CAMERA',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.RECORD_AUDIO',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.WRITE_EXTERNAL_STORAGE',
]) {
  assert.equal(permissionByName.get(permission)?.['tools:node'], 'remove');
}
assert.equal(permissionByName.has('android.permission.ACCESS_BACKGROUND_LOCATION'), false);
assert.equal(permissionByName.has('android.permission.FOREGROUND_SERVICE_LOCATION'), false);
assert.equal(permissionByName.has('android.permission.ACCESS_COARSE_LOCATION'), true);
assert.equal(permissionByName.has('android.permission.ACCESS_FINE_LOCATION'), true);
const application = android.manifest.manifest.application?.[0]?.$;
assert.equal(application?.['android:allowBackup'], 'false');
assert.notEqual(application?.['android:usesCleartextTraffic'], 'true');

const activities = android.manifest.manifest.application?.[0]?.activity ?? [];
const cropperActivity = activities.find(
  (activity) => activity?.$?.['android:name'] === 'com.canhub.cropper.CropImageActivity',
);
assert.equal(cropperActivity?.$?.['android:exported'], 'false');
assert.equal(cropperActivity?.$?.['tools:replace'], 'android:exported');

const providers = android.manifest.manifest.application?.[0]?.provider ?? [];
const clipboardProvider = providers.find(
  (provider) => provider?.$?.['android:name'] === 'expo.modules.clipboard.ClipboardFileProvider',
);
assert.equal(clipboardProvider?.$?.['android:exported'], 'false');
assert.equal(clipboardProvider?.$?.['android:grantUriPermissions'], 'true');
assert.equal(
  clipboardProvider?.$?.['tools:replace'],
  'android:exported,android:grantUriPermissions',
);

console.log('Native capability introspection: PASS');
