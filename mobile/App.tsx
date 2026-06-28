import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { useFonts } from 'expo-font';
import { DefaultTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import { RootNavigator } from './src/navigation/RootNavigator';
import { navigationRef, navigateFromPush } from './src/navigation/ref';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { useAuth } from './src/store/auth';
import { useNotifications } from './src/store/notifications';
import { registerForPush } from './src/services/push';
import { FONT_ASSETS } from './src/fonts';
import { colors, fonts } from './src/theme';

const navTheme: Theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.primary,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    notification: colors.primary,
  },
};

export default function App() {
  const hydrated = useAuth((s) => s.hydrated);
  const token = useAuth((s) => s.token);
  const refreshMe = useAuth((s) => s.refreshMe);
  const fetchNotifications = useNotifications((s) => s.fetch);
  const [fontsLoaded] = useFonts(FONT_ASSETS);

  useEffect(() => {
    if (!token) return;
    void refreshMe();
    void fetchNotifications();
    void registerForPush();

    // Tapping a push routes to its target; a foreground push refreshes the list.
    const tapSub = Notifications.addNotificationResponseReceivedListener((resp) => {
      navigateFromPush(resp.notification.request.content.data as Record<string, unknown>);
    });
    const recvSub = Notifications.addNotificationReceivedListener(() => {
      void useNotifications.getState().fetch();
    });
    return () => {
      tapSub.remove();
      recvSub.remove();
    };
  }, [token, refreshMe, fetchNotifications]);

  if (!hydrated || !fontsLoaded) {
    return (
      <View style={styles.splash}>
        <Text style={styles.logo}>🎾</Text>
        {fontsLoaded ? <Text style={styles.brand}>Vollo</Text> : null}
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <ErrorBoundary>
          <NavigationContainer ref={navigationRef} theme={navTheme}>
            <RootNavigator />
          </NavigationContainer>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 12 },
  logo: { fontSize: 64 },
  brand: { color: colors.text, fontSize: 36, fontFamily: fonts.display, letterSpacing: 0.5 },
});
