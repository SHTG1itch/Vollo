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
assert.ok(ios?.infoPlist && ios?.entitlements, 'Expo introspection omitted iOS native results');
assert.equal(typeof ios.infoPlist.NSLocationWhenInUseUsageDescription, 'string');
assert.equal(ios.infoPlist.NSLocationAlwaysUsageDescription, undefined);
assert.equal(ios.infoPlist.NSLocationAlwaysAndWhenInUseUsageDescription, undefined);
assert.equal(ios.infoPlist.NSCameraUsageDescription, undefined);
assert.equal(ios.infoPlist.NSMicrophoneUsageDescription, undefined);
assert.equal(ios.entitlements['com.apple.developer.applesignin'], undefined);
assert.equal(
  Array.isArray(ios.infoPlist.UIBackgroundModes)
    && ios.infoPlist.UIBackgroundModes.includes('location'),
  false,
);

console.log('Native capability introspection: PASS');
