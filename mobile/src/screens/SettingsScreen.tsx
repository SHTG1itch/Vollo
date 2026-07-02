import React, { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { useAuth } from '../store/auth';
import { Button, Card, Muted } from '../components/ui';
import { showToast } from '../components/Toast';
import { colors, font, fonts, spacing } from '../theme';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function SettingsScreen() {
  const navigation = useNavigation<Nav>();
  const logout = useAuth((s) => s.logout);
  const user = useAuth((s) => s.user);
  const [deleting, setDeleting] = useState(false);

  const confirmLogout = () =>
    Alert.alert('Log out', 'Sign out of Vollo?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: logout },
    ]);

  const confirmDelete = () =>
    Alert.alert(
      'Delete account',
      'This permanently deletes your account, matches, ratings, territories and followers. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete forever',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await api.deleteAccount();
              await logout();
            } catch (e) {
              showToast(e instanceof ApiError ? e.message : 'Could not delete account — please try again.', 'error');
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={styles.content}>
      <Card style={{ gap: spacing.sm }}>
        <Text style={styles.section}>Account</Text>
        {user ? <Muted>Signed in as @{user.username}</Muted> : null}
        <Button label="Edit profile" variant="secondary" onPress={() => navigation.navigate('EditProfile')} />
        <Button label="Find players" variant="secondary" onPress={() => navigation.navigate('UserSearch')} />
      </Card>

      <Card style={{ gap: spacing.sm }}>
        <Text style={styles.section}>Session</Text>
        <Button label="Log out" variant="ghost" onPress={confirmLogout} />
      </Card>

      <Card style={{ gap: spacing.sm }}>
        <Text style={styles.section}>Danger zone</Text>
        <Muted>Deleting your account is permanent and removes all of your data.</Muted>
        <Button label="Delete account" variant="danger" onPress={confirmDelete} loading={deleting} />
      </Card>

      <View style={{ height: spacing.xxl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  section: { color: colors.textDim, fontFamily: fonts.bold, fontSize: font.small, textTransform: 'uppercase', letterSpacing: 0.5 },
});
