const IOS_CLIENT_SUFFIX = '.apps.googleusercontent.com';
const IOS_CLIENT_RE = /^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/;

/**
 * Add the Google iOS URL scheme only when an actual iOS OAuth client is
 * provisioned. A committed placeholder produces a build that installs but
 * cannot return from Google's native sheet. Android does not need this iOS-only
 * plugin option, so it remains available with the configured web client id.
 */
module.exports = ({ config }) => {
  const configuredClient = (
    process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
    ?? config.extra?.googleIosClientId
    ?? ''
  ).trim();

  if (configuredClient && !IOS_CLIENT_RE.test(configuredClient)) {
    throw new Error('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID must be a valid *.apps.googleusercontent.com client id.');
  }

  const appleEnabled =
    process.env.EXPO_PUBLIC_APPLE_AUTH === '1'
    || config.extra?.appleAuthEnabled === true;

  const plugins = (config.plugins ?? []).filter((plugin) => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    return name !== '@react-native-google-signin/google-signin'
      && name !== 'expo-apple-authentication';
  });

  if (configuredClient) {
    const clientPrefix = configuredClient.slice(0, -IOS_CLIENT_SUFFIX.length);
    plugins.push([
      '@react-native-google-signin/google-signin',
      { iosUrlScheme: `com.googleusercontent.apps.${clientPrefix}` },
    ]);
  }
  if (appleEnabled) plugins.push('expo-apple-authentication');

  return {
    ...config,
    plugins,
    ios: {
      ...config.ios,
      // Do not request a paid Apple capability in binaries where the feature
      // is intentionally disabled. Enabling the public flag adds both this
      // entitlement and Expo's required config plugin in one place.
      usesAppleSignIn: appleEnabled,
    },
    extra: {
      ...config.extra,
      googleIosClientId: configuredClient,
      appleAuthEnabled: appleEnabled,
    },
  };
};
