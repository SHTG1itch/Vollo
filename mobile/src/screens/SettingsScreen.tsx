import React, { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { useAuth } from '../store/auth';
import { Avatar, Button, Card, Muted, SectionHeader } from '../components/ui';
import { showToast } from '../components/Toast';
import { tapLight } from '../lib/haptics';
import { colors, font, fonts, spacing } from '../theme';
import type { BlockedUser } from '../types';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function SettingsScreen() {
  const navigation = useNavigation<Nav>();
  const logout = useAuth((s) => s.logout);
  const user = useAuth((s) => s.user);
  const setUser = useAuth((s) => s.setUser);
  const [deleting, setDeleting] = useState(false);
  const [privateSaving, setPrivateSaving] = useState(false);
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [unblocking, setUnblocking] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getBlockedUsers()
      .then((r) => setBlocked(r.users))
      .catch(() => {}); // section just stays empty on a transient failure
  }, []);

  const togglePrivate = async (next: boolean) => {
    if (!user || privateSaving) return;
    tapLight();
    setPrivateSaving(true);
    // Optimistic: flip locally, revert if the save fails.
    setUser({ ...user, is_private: next });
    try {
      const res = await api.updateProfile({ is_private: next });
      setUser(res.user);
    } catch (e) {
      setUser({ ...user, is_private: !next });
      showToast(e instanceof ApiError ? e.message : 'Could not update privacy — please try again.', 'error');
    } finally {
      setPrivateSaving(false);
    }
  };

  const unblock = async (u: BlockedUser) => {
    setUnblocking(u.id);
    try {
      await api.unblockUser(u.username);
      setBlocked((list) => list.filter((b) => b.id !== u.id));
      showToast(`Unblocked @${u.username}`, 'success');
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'Could not unblock — please try again.', 'error');
    } finally {
      setUnblocking(null);
    }
  };

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
        <SectionHeader title="Account" />
        {user ? <Muted>Signed in as @{user.username}</Muted> : null}
        <Button label="Edit profile" variant="secondary" onPress={() => navigation.navigate('EditProfile')} />
        <Button label="Find players" variant="secondary" onPress={() => navigation.navigate('UserSearch')} />
      </Card>

      <Card style={{ gap: spacing.sm }}>
        <SectionHeader title="Privacy" />
        <View style={styles.switchRow}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.switchLabel}>Private account</Text>
            <Muted style={{ textAlign: 'left' }}>
              Only your followers can see your matches and stats. Your name and profile stay findable.
            </Muted>
          </View>
          <Switch
            value={user?.is_private ?? false}
            onValueChange={togglePrivate}
            disabled={privateSaving}
            trackColor={{ true: colors.primary, false: colors.border }}
            thumbColor={colors.white}
          />
        </View>

        {blocked.length > 0 ? (
          <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
            <Text style={styles.subsection}>Blocked players</Text>
            {blocked.map((u) => (
              <View key={u.id} style={styles.blockedRow}>
                <Avatar name={u.display_name} uri={u.avatar_url} size={34} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.blockedName}>{u.display_name}</Text>
                  <Text style={styles.blockedHandle}>@{u.username}</Text>
                </View>
                <Button
                  label="Unblock"
                  variant="secondary"
                  onPress={() => unblock(u)}
                  loading={unblocking === u.id}
                  style={{ height: 34, paddingHorizontal: spacing.md }}
                />
              </View>
            ))}
          </View>
        ) : null}
      </Card>

      <Card style={{ gap: spacing.sm }}>
        <SectionHeader title="Session" />
        <Button label="Log out" variant="ghost" onPress={confirmLogout} />
      </Card>

      <Card style={{ gap: spacing.sm }}>
        <SectionHeader title="Danger zone" />
        <Muted>Deleting your account is permanent and removes all of your data.</Muted>
        <Button label="Delete account" variant="danger" onPress={confirmDelete} loading={deleting} />
      </Card>

      <View style={{ height: spacing.xxl }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  subsection: { color: colors.textFaint, fontFamily: fonts.bold, fontSize: font.tiny, textTransform: 'uppercase', letterSpacing: 0.5 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchLabel: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body },
  blockedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  blockedName: { color: colors.text, fontFamily: fonts.bold, fontSize: font.small },
  blockedHandle: { color: colors.textFaint, fontSize: font.tiny },
});
