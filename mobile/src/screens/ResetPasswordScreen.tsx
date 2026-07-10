import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { Button, Field, H1, Loading, Muted, Screen } from '../components/ui';
import { showToast } from '../components/Toast';
import { useAuth } from '../store/auth';
import { colors, font, fonts, radius, shadow, spacing } from '../theme';

export function ResetPasswordScreen() {
  const token = useAuth((state) => state.token);
  const linkError = useAuth((state) => state.passwordRecoveryError);
  const completePasswordRecovery = useAuth((state) => state.completePasswordRecovery);
  const cancelPasswordRecovery = useAuth((state) => state.cancelPasswordRecovery);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submitActive = useRef(false);
  const valid = password.length >= 8 && password.length <= 72 && password === confirmation;

  const submit = async () => {
    if (!valid || submitActive.current || loading || linkError) return;
    submitActive.current = true;
    setLoading(true);
    setError(null);
    try {
      await completePasswordRecovery(password);
      showToast('Password updated', 'success');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update your password.');
    } finally {
      submitActive.current = false;
      setLoading(false);
    }
  };

  if (!token && !linkError) {
    return (
      <Screen edges={['top', 'bottom']}>
        <Loading label="Opening secure reset link" />
      </Screen>
    );
  }

  return (
    <Screen edges={['top', 'bottom']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
        <View style={styles.container}>
          <View style={styles.header}>
            <H1>Choose a new password</H1>
            <Muted>Use at least 8 characters. Your reset session stays on this device only.</Muted>
          </View>
          <View style={styles.form}>
            {linkError ? (
              <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
                {linkError}
              </Text>
            ) : (
              <>
                <Field
                  label="New password"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoComplete="new-password"
                  textContentType="newPassword"
                  maxLength={72}
                />
                <Field
                  label="Confirm new password"
                  value={confirmation}
                  onChangeText={setConfirmation}
                  secureTextEntry
                  autoComplete="new-password"
                  textContentType="newPassword"
                  maxLength={72}
                  returnKeyType="done"
                  onSubmitEditing={submit}
                />
                {confirmation && password !== confirmation ? (
                  <Text style={styles.error} accessibilityRole="alert">Passwords do not match.</Text>
                ) : null}
                {error ? (
                  <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">
                    {error}
                  </Text>
                ) : null}
                <Button label="Update password" onPress={submit} loading={loading} disabled={!valid} />
              </>
            )}
            <Button
              label={linkError ? 'Back to sign in' : 'Cancel password reset'}
              variant="ghost"
              onPress={() => void cancelPasswordRecovery()}
              disabled={loading}
            />
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
  error: { color: colors.loss, fontSize: font.small, fontFamily: fonts.bold, textAlign: 'center' },
});
