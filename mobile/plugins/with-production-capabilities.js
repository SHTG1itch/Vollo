const { withEntitlementsPlist, withInfoPlist } = require('@expo/config-plugins');

/** Keep optional native packages from declaring capabilities that Vollo does
 * not use in the current release. Config-plugin introspection verifies these
 * removals after every dependency install. */
module.exports = function withProductionCapabilities(config, options = {}) {
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
