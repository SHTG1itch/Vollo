import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { Button, Card, ErrorState, Loading, Screen } from '../components/ui';
import { showToast } from '../components/Toast';
import { useAuth } from '../store/auth';
import { colors, font, fonts, spacing } from '../theme';
import { CURRENT_TERMS_VERSION, TERMS_SECTIONS } from '../policy/terms';

type Props = NativeStackScreenProps<RootStackParamList, 'Terms'>;

export function TermsScreen({ route }: Props) {
  const user = useAuth((s) => s.user);
  const meError = useAuth((s) => s.meError);
  const refreshMe = useAuth((s) => s.refreshMe);
  const acceptTerms = useAuth((s) => s.acceptTerms);
  const logout = useAuth((s) => s.logout);
  const [accepting, setAccepting] = useState(false);
  const viewOnly = route.params?.viewOnly === true;

  if (!viewOnly && !user) {
    if (meError) {
      return (
        <Screen>
          <ErrorState title="Couldn't load your account" message="Connect to the internet to review and accept the Terms of Use." onRetry={refreshMe} />
          <Button label="Log out" variant="ghost" onPress={logout} style={styles.logout} />
        </Screen>
      );
    }
    return <Loading label="Loading your account…" />;
  }

  const accept = async () => {
    if (accepting) return;
    setAccepting(true);
    try {
      await acceptTerms(CURRENT_TERMS_VERSION);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not accept the Terms of Use. Try again.', 'error');
      setAccepting(false);
    }
  };

  return (
    <Screen edges={viewOnly ? [] : ['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>VOLLO</Text>
          <Text style={styles.title}>Terms of Use</Text>
          <Text style={styles.version}>Effective August 16, 2026 · Version {CURRENT_TERMS_VERSION}</Text>
          {!viewOnly ? (
            <Text style={styles.intro}>Review these rules before joining the Vollo community.</Text>
          ) : null}
        </View>

        {TERMS_SECTIONS.map((section) => (
          <Card key={section.title} style={styles.section}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <Text style={styles.body}>{section.body}</Text>
          </Card>
        ))}

        {!viewOnly ? (
          <Card style={styles.acceptCard}>
            <Text style={styles.consent}>By tapping below, you agree to these Terms of Use.</Text>
            <Button label="Accept Terms of Use" onPress={accept} loading={accepting} />
            <Button label="Log out" variant="ghost" onPress={logout} disabled={accepting} />
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  header: { gap: spacing.xs, paddingVertical: spacing.sm },
  eyebrow: { color: colors.primary, fontFamily: fonts.bold, fontSize: font.tiny, letterSpacing: 2 },
  title: { color: colors.text, fontFamily: fonts.display, fontSize: font.h1 + 4 },
  version: { color: colors.textFaint, fontSize: font.tiny },
  intro: { color: colors.textDim, fontSize: font.body, marginTop: spacing.sm },
  section: { gap: spacing.sm },
  sectionTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: font.h3 },
  body: { color: colors.textDim, fontFamily: fonts.body, fontSize: font.body, lineHeight: 22 },
  acceptCard: { gap: spacing.sm, marginTop: spacing.sm },
  consent: { color: colors.text, fontFamily: fonts.bold, fontSize: font.small, textAlign: 'center' },
  logout: { marginHorizontal: spacing.xl, marginBottom: spacing.xl },
});
