import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Card, Screen } from '../components/ui';
import { PRIVACY_EFFECTIVE_DATE, PRIVACY_SECTIONS } from '../policy/privacy';
import { colors, font, fonts, spacing } from '../theme';

export function PrivacyScreen() {
  return (
    <Screen edges={[]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>VOLLO</Text>
          <Text style={styles.title}>Privacy Policy</Text>
          <Text style={styles.version}>Effective {PRIVACY_EFFECTIVE_DATE}</Text>
        </View>
        {PRIVACY_SECTIONS.map((section) => (
          <Card key={section.title} style={styles.section}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <Text style={styles.body}>{section.body}</Text>
          </Card>
        ))}
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
  section: { gap: spacing.sm },
  sectionTitle: { color: colors.text, fontFamily: fonts.heading, fontSize: font.h3 },
  body: { color: colors.textDim, fontFamily: fonts.body, fontSize: font.body, lineHeight: 22 },
});
