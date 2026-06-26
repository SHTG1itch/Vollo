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
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setError(null);
    setLoading(true);
    try {
      await register({
        username: username.trim(),
        email: email.trim(),
        password,
        display_name: displayName.trim(),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

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
