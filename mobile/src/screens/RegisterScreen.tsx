import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useAuth } from '../store/auth';
import { Button, Field, H1, Muted, Screen } from '../components/ui';
import { colors, font, radius, shadow, spacing } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Register'>;

export function RegisterScreen({ navigation }: Props) {
  const register = useAuth((s) => s.register);
  const resendConfirmation = useAuth((s) => s.resendConfirmation);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Once sign-up needs email confirmation, swap the form for an "awaiting
  // confirmation" panel rather than leaving the user on a form that looks unsent.
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [resendNote, setResendNote] = useState<string | null>(null);
  const [resending, setResending] = useState(false);

  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      const { needsConfirmation } = await register({
        username: username.trim(),
        email: email.trim(),
        password,
        display_name: displayName.trim(),
      });
      // No confirmation needed → the auth bridge logs them straight in.
      if (needsConfirmation) setAwaitingConfirmation(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    setResendNote(null);
    setResending(true);
    try {
      await resendConfirmation(email.trim());
      setResendNote('Sent — check your inbox (and spam).');
    } catch (e) {
      setResendNote(e instanceof Error ? e.message : 'Could not resend right now.');
    } finally {
      setResending(false);
    }
  };

  if (awaitingConfirmation) {
    return (
      <Screen edges={['top', 'bottom']}>
        <View style={[styles.container, styles.fill]}>
          <View style={styles.header}>
            <Text style={styles.logo}>📬</Text>
            <H1>Confirm your email</H1>
            <Muted>
              We sent a confirmation link to {email.trim()}. Tap it, then come back and sign in.
            </Muted>
          </View>
          <View style={styles.form}>
            {resendNote ? <Text style={styles.note}>{resendNote}</Text> : null}
            <Button label="Resend email" variant="ghost" onPress={resend} loading={resending} />
            <Button label="Back to sign in" onPress={() => navigation.goBack()} />
          </View>
        </View>
      </Screen>
    );
  }

  // Mirror the backend's rules so most rejections are caught before the request.
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const usernameOk = /^[a-zA-Z0-9_]{3,20}$/.test(username.trim());
  const displayOk = displayName.trim().length >= 1 && displayName.trim().length <= 60;
  const valid = displayOk && usernameOk && emailOk && password.length >= 8 && password.length <= 72;

  return (
    <Screen edges={['top', 'bottom']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <H1>Join Vollo</H1>
            <Muted>Your tennis story starts here.</Muted>
          </View>

          <View style={styles.form}>
            <Field label="Display name" value={displayName} onChangeText={setDisplayName} placeholder="Srivats I." />
            <Field
              label="Username"
              autoCapitalize="none"
              autoCorrect={false}
              value={username}
              onChangeText={setUsername}
              placeholder="srivats"
            />
            <Field
              label="Email"
              autoCapitalize="none"
              keyboardType="email-address"
              autoCorrect={false}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
            />
            <Field label="Password" secureTextEntry value={password} onChangeText={setPassword} placeholder="min 8 chars" />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Button label="Create account" onPress={submit} loading={loading} disabled={!valid} />
            <Button label="I already have an account" variant="ghost" onPress={() => navigation.goBack()} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.xl },
  fill: { flex: 1 },
  logo: { fontSize: 56, textAlign: 'center' },
  note: { color: colors.text, fontSize: font.small, textAlign: 'center' },
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
  error: { color: colors.loss, fontSize: font.small, textAlign: 'center' },
});
