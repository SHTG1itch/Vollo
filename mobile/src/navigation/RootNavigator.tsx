import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { RootStackParamList } from './types';
import { useAuth } from '../store/auth';
import { Tabs } from './Tabs';
import { LoginScreen } from '../screens/LoginScreen';
import { RegisterScreen } from '../screens/RegisterScreen';
import { MatchDetailScreen } from '../screens/MatchDetailScreen';
import { CourtDetailScreen } from '../screens/CourtDetailScreen';
import { CourtsScreen } from '../screens/CourtsScreen';
import { AddCourtScreen } from '../screens/AddCourtScreen';
import { LeaderboardScreen } from '../screens/LeaderboardScreen';
import { UserProfileScreen } from '../screens/ProfileScreen';
import { EditProfileScreen } from '../screens/EditProfileScreen';
import { UserSearchScreen } from '../screens/UserSearchScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { ScheduledMatchesScreen } from '../screens/ScheduledMatchesScreen';
import { ScheduleMatchScreen } from '../screens/ScheduleMatchScreen';
import { colors, fonts } from '../theme';

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  const token = useAuth((s) => s.token);

  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.primary,
        headerTitleStyle: { color: colors.text, fontFamily: fonts.heading },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      {token ? (
        <Stack.Group>
          <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
          <Stack.Screen name="MatchDetail" component={MatchDetailScreen} options={{ title: 'Match' }} />
          <Stack.Screen name="Court" component={CourtDetailScreen} options={{ title: 'Court' }} />
          <Stack.Screen name="Courts" component={CourtsScreen} options={{ headerShown: false }} />
          <Stack.Screen name="AddCourt" component={AddCourtScreen} options={{ title: 'Add a court' }} />
          <Stack.Screen name="Leaderboard" component={LeaderboardScreen} options={{ title: 'Leaderboard' }} />
          <Stack.Screen name="UserProfile" component={UserProfileScreen} options={{ title: 'Player' }} />
          <Stack.Screen name="EditProfile" component={EditProfileScreen} options={{ title: 'Edit profile' }} />
          <Stack.Screen name="UserSearch" component={UserSearchScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
          <Stack.Screen name="ScheduledMatches" component={ScheduledMatchesScreen} options={{ title: 'Matches & challenges' }} />
          <Stack.Screen name="ScheduleMatch" component={ScheduleMatchScreen} options={{ title: 'Challenge' }} />
        </Stack.Group>
      ) : (
        <Stack.Group screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Login" component={LoginScreen} />
          <Stack.Screen name="Register" component={RegisterScreen} />
        </Stack.Group>
      )}
    </Stack.Navigator>
  );
}
