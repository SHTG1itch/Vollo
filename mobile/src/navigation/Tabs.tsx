import React, { useEffect } from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList, TabParamList } from './types';
import { hasSeenQuickstart } from '../screens/QuickstartScreen';
import { FeedScreen } from '../screens/FeedScreen';
import { MapScreen } from '../screens/MapScreen';
import { LogMatchScreen } from '../screens/LogMatchScreen';
import { NotificationsScreen } from '../screens/NotificationsScreen';
import { MeScreen } from '../screens/ProfileScreen';
import { useNotifications } from '../store/notifications';
import { Icon, type IconName } from '../components/icons';
import { colors, fonts, shadow } from '../theme';

const Tab = createBottomTabNavigator<TabParamList>();

const ICONS: Record<keyof TabParamList, IconName> = {
  Feed: 'home',
  Map: 'map',
  Log: 'plus-circle',
  Alerts: 'bell',
  Me: 'user',
};

function icon(name: keyof TabParamList) {
  // color comes from tabBarActive/InactiveTintColor; a heavier stroke when
  // focused gives the Strava-style weight shift without swapping glyphs.
  const TabIcon = ({ color, focused }: { color: string; focused: boolean }) => (
    <Icon
      name={ICONS[name]}
      size={name === 'Log' ? 27 : 23}
      color={color}
      strokeWidth={focused ? 2.4 : 1.8}
    />
  );
  TabIcon.displayName = `TabIcon(${name})`;
  return TabIcon;
}

export function Tabs() {
  const unread = useNotifications((s) => s.unread);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  // First launch on this device: open the quickstart guide over the tabs so a
  // brand-new player learns the app before their first session. One-shot — the
  // guide marks itself seen on open and stays reopenable from Settings.
  useEffect(() => {
    let active = true;
    void hasSeenQuickstart().then((seen) => {
      if (active && !seen) navigation.navigate('Quickstart');
    });
    return () => {
      active = false;
    };
  }, [navigation]);

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          // No fixed height — the navigator sizes itself from the safe-area
          // inset, so devices without a home indicator aren't over-padded.
          paddingTop: 6,
          ...shadow.bar,
        },
        tabBarLabelStyle: { fontSize: 11, fontFamily: fonts.bold },
      }}
    >
      <Tab.Screen name="Feed" component={FeedScreen} options={{ tabBarIcon: icon('Feed') }} />
      <Tab.Screen name="Map" component={MapScreen} options={{ tabBarIcon: icon('Map') }} />
      <Tab.Screen name="Log" component={LogMatchScreen} options={{ tabBarIcon: icon('Log'), tabBarLabel: 'Log' }} />
      <Tab.Screen
        name="Alerts"
        component={NotificationsScreen}
        options={{ tabBarIcon: icon('Alerts'), tabBarBadge: unread > 0 ? unread : undefined }}
      />
      <Tab.Screen name="Me" component={MeScreen} options={{ tabBarIcon: icon('Me') }} />
    </Tab.Navigator>
  );
}
