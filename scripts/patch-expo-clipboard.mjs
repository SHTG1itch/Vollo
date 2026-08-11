import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

const packageRoot = new URL('../mobile/node_modules/expo-clipboard/', import.meta.url);
const packageJson = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
assert.equal(packageJson.version, '8.0.8', 'Review the Expo clipboard security patch for the installed version');

async function replaceOnce(path, vulnerable, fixed, fixedMarker = fixed) {
  const url = new URL(path, packageRoot);
  const source = await readFile(url, 'utf8');
  if (source.includes(fixedMarker)) return;
  assert.equal(source.split(vulnerable).length, 2, `Expected one vulnerable block in ${path}`);
  await writeFile(url, source.replace(vulnerable, fixed));
}

await replaceOnce(
  'android/src/main/AndroidManifest.xml',
  'android:exported="true">',
  'android:exported="false"\n      android:grantUriPermissions="true">',
);

await replaceOnce(
  'android/src/main/java/expo/modules/clipboard/ClipboardFileProvider.kt',
  `
    if (!info.exported) {
      throw AssertionError("ClipboardFileProvider must be exported")
    }
`,
  '',
  'super.attachInfo(context, info)\n\n    strategy = getPathStrategy',
);

console.log('Applied Expo clipboard provider security backport');
