import React, { useEffect, useRef } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import { useFonts } from 'expo-font';
import { DefaultTheme, NavigationContainer, type LinkingOptions, type Theme } from '@react-navigation/native';
import type { RootStackParamList } from './src/navigation/types';
import { RootNavigator } from './src/navigation/RootNavigator';
import { navigationRef, navigateFromPush, flushPendingPush } from './src/navigation/ref';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { ToastHost } from './src/components/Toast';
import { useAuth } from './src/store/auth';
import { useNotifications } from './src/store/notifications';
import { registerForPush } from './src/services/push';
import { FONT_ASSETS } from './src/fonts';
import { BallSpinner } from './src/components/BallSpinner';
import { VolloWordmark } from './src/components/VolloLogo';
import { colors } from './src/theme';

// vollo:// deep links (matches the `scheme` in app.json) — vollo://match/:id,
// vollo://court/:id, vollo://player/:username. Tab and auth screens resolve by
// name so a link never dead-ends while signed out.
const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['vollo://'],
  config: {
    screens: {
      MatchDetail: 'match/:matchId',
      Court: 'court/:courtId',
      UserProfile: 'player/:username',
      ScheduledMatches: 'challenges',
      Tabs: {
        screens: {
          Feed: 'feed',
          Map: 'map',
          Log: 'log',
          Alerts: 'alerts',
          Me: 'me',
        },
      },
    },
  },
};

// Replay a vollo:// deep link that arrived while signed out. React Navigation's
// linking config silently drops links to detail screens while the auth stack is
// mounted (MatchDetail/Court/UserProfile only exist when authed), so App parks
// the URL and routes it here once the token exists and the authed stack is up.
// navigateFromPush also validates the ids, exactly as it does for push payloads.
function replayDeepLink(url: string): void {
  let segments: string[];
  try {
    segments = url
      .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // strip "vollo://"
      .split(/[?#]/)[0]
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
  } catch {
    return; // malformed percent-encoding — drop it
  }
  const [head, param] = segments;
  if (head === 'match' && param) navigateFromPush({ matchId: param });
  else if (head === 'court' && param) navigateFromPush({ courtId: param });
  else if (head === 'player' && param) navigateFromPush({ username: param });
  else if (head === 'challenges' && navigationRef.isReady()) navigationRef.navigate('ScheduledMatches');
}

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
  const passwordRecovery = useAuth((s) => s.passwordRecovery);
  const coldStartHandled = useRef(false);
  // A deep link that landed while signed out, parked until sign-in (the linking
  // config can't route it — the detail screens aren't mounted yet).
  const pendingLink = useRef<string | null>(null);
  const initialUrlChecked = useRef(false);
  // Gate render on fonts, but never hang on a load failure — RN simply falls
  // back to the system font for an unresolved family, so proceed on error too.
  const [fontsLoaded, fontError] = useFonts(FONT_ASSETS);
  const fontsReady = fontsLoaded || fontError != null;

  useEffect(() => {
    // A password-reset callback creates a temporary authenticated session. Do
    // not register that session for push or load account data until the user has
    // actually completed the password change.
    if (!isAuthed || passwordRecovery) return;
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
  }, [isAuthed, passwordRecovery]);

  // Consume reset credentials before navigation can retain them. While signed
  // out, park any other vollo:// link instead of losing its destination.
  useEffect(() => {
    let active = true;
    const handleUrl = async (url: string) => {
      const consumed = await useAuth.getState().beginPasswordRecovery(url);
      if (!active) return;
      if (consumed) {
        pendingLink.current = null;
      } else if (!useAuth.getState().token) {
        pendingLink.current = url;
      }
    };
    // The launch URL is only relevant once — don't re-park it after a logout.
    if (!initialUrlChecked.current) {
      initialUrlChecked.current = true;
      void Linking.getInitialURL().then((url) => {
        if (url) void handleUrl(url);
      });
    }
    const sub = Linking.addEventListener('url', ({ url }) => {
      void handleUrl(url);
    });
    return () => {
      active = false;
      sub.remove();
    };
  }, []);

  // …and replay it as soon as the user is signed in and the authed stack exists.
  useEffect(() => {
    if (!isAuthed || passwordRecovery || !pendingLink.current) return;
    const url = pendingLink.current;
    pendingLink.current = null;
    replayDeepLink(url);
  }, [isAuthed, passwordRecovery]);

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
          <NavigationContainer ref={navigationRef} theme={navTheme} linking={linking} onReady={flushPendingPush}>
            <RootNavigator />
          </NavigationContainer>
          <ToastHost />
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', gap: 16 },
});
