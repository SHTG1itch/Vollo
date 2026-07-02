import React from 'react';
import { Text } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type { TabParamList } from './types';
import { FeedScreen } from '../screens/FeedScreen';
import { MapScreen } from '../screens/MapScreen';
import { LogMatchScreen } from '../screens/LogMatchScreen';
import { NotificationsScreen } from '../screens/NotificationsScreen';
import { MeScreen } from '../screens/ProfileScreen';
import { useNotifications } from '../store/notifications';
import { colors, fonts, shadow } from '../theme';

const Tab = createBottomTabNavigator<TabParamList>();

const ICONS: Record<keyof TabParamList, string> = {
  Feed: '🎾',
  Map: '🗺️',
  Log: '➕',
  Alerts: '🔔',
  Me: '👤',
};

function icon(name: keyof TabParamList) {
  return ({ focused }: { focused: boolean }) => (
    <Text style={{ fontSize: name === 'Log' ? 26 : 20, opacity: focused ? 1 : 0.5 }}>{ICONS[name]}</Text>
  );
}

export function Tabs() {
  const unread = useNotifications((s) => s.unread);
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: 88,
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
