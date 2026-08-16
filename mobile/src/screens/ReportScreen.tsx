import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError, type ReportReason } from '../api/client';
import { Button, Card, Field, Muted } from '../components/ui';
import { showToast } from '../components/Toast';
import { colors, font, fonts, radius, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Report'>;

const REASONS: { value: ReportReason; label: string; description: string }[] = [
  { value: 'spam', label: 'Spam or scam', description: 'Unwanted promotion, fraud, or misleading content' },
  { value: 'harassment', label: 'Harassment or bullying', description: 'Targeted abuse, threats, or unwanted contact' },
  { value: 'hate', label: 'Hateful content', description: 'Attacks based on a protected characteristic' },
  { value: 'sexual', label: 'Sexual content', description: 'Sexually explicit or exploitative material' },
  { value: 'violence', label: 'Violence or danger', description: 'Violent threats, graphic content, or dangerous activity' },
  { value: 'impersonation', label: 'Impersonation', description: 'Pretending to be another person or organization' },
  { value: 'privacy', label: 'Privacy violation', description: 'Personal information shared without permission' },
  { value: 'other', label: 'Something else', description: 'Another violation of the Vollo Terms of Use' },
];

export function ReportScreen({ route, navigation }: Props) {
  const { subjectType, subjectId, subjectLabel } = route.params;
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!reason || submitting) return;
    setSubmitting(true);
    try {
      await api.reportContent({
        subject_type: subjectType,
        subject_id: subjectId,
        reason,
        details: details.trim() || undefined,
      });
      showToast('Report received. Thank you for helping keep Vollo safe.', 'success');
      navigation.goBack();
    } catch (error) {
      showToast(error instanceof ApiError ? error.message : 'Could not submit the report. Try again.', 'error');
      setSubmitting(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={{ gap: spacing.xs }}>
        <Text style={styles.title}>Report {subjectLabel}</Text>
        <Muted style={{ textAlign: 'left' }}>Reports are confidential. Choose the reason that fits best.</Muted>
      </View>

      <View style={{ gap: spacing.sm }} accessibilityRole="radiogroup">
        {REASONS.map((item) => {
          const selected = reason === item.value;
          return (
            <Pressable
              key={item.value}
              onPress={() => setReason(item.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={item.label}
              style={({ pressed }) => [styles.reason, selected && styles.reasonSelected, pressed && { opacity: 0.75 }]}
            >
              <View style={[styles.radio, selected && styles.radioSelected]} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.reasonLabel}>{item.label}</Text>
                <Text style={styles.reasonDescription}>{item.description}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      <Card style={{ gap: spacing.sm }}>
        <Field
          label="Additional details (optional)"
          value={details}
          onChangeText={setDetails}
          maxLength={1000}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
          placeholder="Add context that will help us review this report"
          style={styles.details}
        />
        <Text style={styles.count}>{details.length}/1000</Text>
      </Card>

      <Button label="Submit report" variant="danger" onPress={submit} loading={submitting} disabled={!reason} />
      <Muted>For immediate danger, contact local emergency services.</Muted>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.lg },
  title: { color: colors.text, fontFamily: fonts.display, fontSize: font.h1 },
  reason: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  reasonSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.textFaint },
  radioSelected: { borderWidth: 5, borderColor: colors.primary, backgroundColor: colors.white },
  reasonLabel: { color: colors.text, fontFamily: fonts.bold, fontSize: font.body },
  reasonDescription: { color: colors.textDim, fontSize: font.small },
  details: { minHeight: 100 },
  count: { color: colors.textFaint, fontSize: font.tiny, textAlign: 'right' },
});
