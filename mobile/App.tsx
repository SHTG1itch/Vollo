import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { useFonts } from 'expo-font';
import { DefaultTheme, NavigationContainer, type Theme } from '@react-navigation/native';
import { RootNavigator } from './src/navigation/RootNavigator';
import { navigationRef, navigateFromPush, flushPendingPush } from './src/navigation/ref';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { useAuth } from './src/store/auth';
import { useNotifications } from './src/store/notifications';
import { registerForPush } from './src/services/push';
import { FONT_ASSETS } from './src/fonts';
import { BallSpinner } from './src/components/BallSpinner';
import { VolloWordmark } from './src/components/VolloLogo';
import { colors } from './src/theme';

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
  // Boolean, not the raw token: Supabase rotates the token string on every
  // background refresh, and the setup effect below must not re-run (re-register
  // push, tear down listeners) each time — only on actual sign-in/out.
  const isAuthed = useAuth((s) => s.token != null);
  const coldStartHandled = useRef(false);
  // Gate render on fonts, but never hang on a load failure — RN simply falls
  // back to the system font for an unresolved family, so proceed on error too.
  const [fontsLoaded, fontError] = useFonts(FONT_ASSETS);
  const fontsReady = fontsLoaded || fontError != null;

  useEffect(() => {
    if (!isAuthed) return;
    void useAuth.getState().refreshMe();
    void useNotifications.getState().fetch();
    void registerForPush();

    // Tapping a push routes to its target; a foreground push refreshes the list.
    const tapSub = Notifications.addNotificationResponseReceivedListener((resp) => {
      navigateFromPush(resp.notification.request.content.data as Record<string, unknown>);
    });
    const recvSub = Notifications.addNotificationReceivedListener(() => {
      void useNotifications.getState().fetch();
    });

    // A push tapped while the app was killed launches it without ever firing the
    // response listener — pick that tap up once and route to its target (parked
    // by navigateFromPush until the container is ready, flushed from onReady).
    if (!coldStartHandled.current) {
      coldStartHandled.current = true;
      void Notifications.getLastNotificationResponseAsync().then((resp) => {
        if (resp) navigateFromPush(resp.notification.request.content.data as Record<string, unknown>);
      });
    }

    return () => {
      tapSub.remove();
      recvSub.remove();
    };
  }, [isAuthed]);

  if (!hydrated || !fontsReady) {
    return (
      <View style={styles.splash}>
        <BallSpinner size={84} mode="loop" />
        {fontsLoaded ? <VolloWordmark size={34} /> : null}
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <ErrorBoundary>
          <NavigationContainer ref={navigationRef} theme={navTheme} onReady={flushPendingPush}>
            <RootNavigator />
          </NavigationContainer>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 16 },
});
