module.exports = function (api) {
  api.cache(true);
  return {
    // babel-preset-expo (SDK 54) automatically adds the Reanimated/Worklets
    // Babel plugin when react-native-reanimated is installed, so it no longer
    // needs to be listed here (listing it again would apply it twice).
    presets: ['babel-preset-expo'],
  };
};
