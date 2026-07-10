import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { Button, Field, H1, Muted, Screen } from '../components/ui';
import { useAuth } from '../store/auth';
import { colors, font, fonts, radius, shadow, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'ForgotPassword'>;

export function ForgotPasswordScreen({ navigation }: Props) {
  const requestPasswordReset = useAuth((state) => state.requestPasswordReset);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitActive = useRef(false);
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const submit = async () => {
    if (!emailValid || submitActive.current || loading) return;
    submitActive.current = true;
    setLoading(true);
    setError(null);
    try {
      await requestPasswordReset(email.trim());
      // Keep this deliberately account-agnostic to avoid email enumeration.
      setSent(true);
    } catch {
      setError('Could not send a reset email right now. Check your connection and try again.');
    } finally {
      submitActive.current = false;
      setLoading(false);
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
        <View style={styles.container}>
          <View style={styles.header}>
            <H1>Reset password</H1>
            <Muted>Enter your account email and we’ll send a secure reset link.</Muted>
          </View>
          <View style={styles.form}>
            {sent ? (
              <Text style={styles.success} accessibilityRole="alert" accessibilityLiveRegion="polite">
                If an account exists for that email, a reset link is on its way. Check your inbox and spam folder.
              </Text>
            ) : (
              <Field
                label="Email"
                value={email}
                onChangeText={setEmail}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                keyboardType="email-address"
                returnKeyType="send"
                onSubmitEditing={submit}
              />
            )}
            {error ? (
              <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
                {error}
              </Text>
            ) : null}
            {!sent ? (
              <Button label="Send reset link" onPress={submit} loading={loading} disabled={!emailValid} />
            ) : (
              <Button label="Send another link" variant="secondary" onPress={() => setSent(false)} />
            )}
            <Button label="Back to sign in" variant="ghost" onPress={() => navigation.goBack()} />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  container: { flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.xl },
  header: { alignItems: 'center', gap: spacing.xs },
  form: {
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  success: { color: colors.text, fontSize: font.small, fontFamily: fonts.body, textAlign: 'center' },
  error: { color: colors.loss, fontSize: font.small, fontFamily: fonts.bold, textAlign: 'center' },
});
