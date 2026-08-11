const {
  AndroidConfig,
  withAndroidManifest,
  withEntitlementsPlist,
  withInfoPlist,
  withProjectBuildGradle,
} = require('@expo/config-plugins');

const SECURE_CROPPER_VERSION = '4.7.0';
const CROPPER_ACTIVITY = 'com.canhub.cropper.CropImageActivity';

/** Keep optional native packages from declaring capabilities that Vollo does
 * not use in the current release. Config-plugin introspection verifies these
 * removals after every dependency install. */
module.exports = function withProductionCapabilities(config, options = {}) {
  config = withAndroidManifest(config, (result) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(result.modResults);
    const activities = application.activity ??= [];
    let cropper = activities.find((activity) => activity.$?.['android:name'] === CROPPER_ACTIVITY);
    if (!cropper) {
      cropper = { $: { 'android:name': CROPPER_ACTIVITY } };
      activities.push(cropper);
    }
    cropper.$['android:exported'] = 'false';
    cropper.$['tools:replace'] = 'android:exported';
    return result;
  });

  config = withProjectBuildGradle(config, (result) => {
    const marker = `com.vanniktech:android-image-cropper:${SECURE_CROPPER_VERSION}`;
    if (!result.modResults.contents.includes(marker)) {
      result.modResults.contents += `

// Expo SDK 54 pins cropper 4.6.0, before upstream URI validation fixes.
allprojects {
  configurations.configureEach {
    resolutionStrategy.force '${marker}'
  }
}
`;
    }
    return result;
  });

  config = withInfoPlist(config, (result) => {
    if (!options.backgroundLocationEnabled) {
      delete result.modResults.NSLocationAlwaysUsageDescription;
      delete result.modResults.NSLocationAlwaysAndWhenInUseUsageDescription;
      if (Array.isArray(result.modResults.UIBackgroundModes)) {
        result.modResults.UIBackgroundModes = result.modResults.UIBackgroundModes.filter(
          (mode) => mode !== 'location',
        );
        if (result.modResults.UIBackgroundModes.length === 0) {
          delete result.modResults.UIBackgroundModes;
        }
      }
    }
    return result;
  });

  return withEntitlementsPlist(config, (result) => {
    if (!options.appleEnabled) {
      delete result.modResults['com.apple.developer.applesignin'];
    }
    return result;
  });
};
