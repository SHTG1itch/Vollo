import React, { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { api, ApiError } from '../api/client';
import { Button, Card, Field, Muted } from '../components/ui';
import { showToast } from '../components/Toast';
import { notifySuccess } from '../lib/haptics';
import { colors, spacing } from '../theme';
import { newClientKey } from '../utils/idempotency';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function CreateClubScreen() {
  const navigation = useNavigation<Nav>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [city, setCity] = useState('');
  const [saving, setSaving] = useState(false);
  const saveActive = useRef(false);
  const requestKey = useRef(newClientKey()).current;

  const canSave = name.trim().length >= 3;

  const save = async () => {
    if (!canSave || saveActive.current || saving) return;
    saveActive.current = true;
    setSaving(true);
    try {
      const res = await api.createClub({
        client_key: requestKey,
        name: name.trim(),
        description: description.trim() || undefined,
        city: city.trim() || undefined,
      });
      notifySuccess();
      showToast('Club created — you are its first admin. 🏟️', 'success');
      navigation.replace('Club', { clubId: res.club.id });
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'Could not create the club — please try again.', 'error');
    } finally {
      saveActive.current = false;
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: spacing.md }}>
          <Field
            label="Club name"
            placeholder="e.g. Riverside Rallies"
            value={name}
            onChangeText={setName}
            maxLength={60}
            autoFocus
          />
          <Field
            label="Description (optional)"
            placeholder="Who plays here, when, and what's the vibe?"
            value={description}
            onChangeText={setDescription}
            maxLength={280}
            multiline
            style={{ height: 90, paddingTop: spacing.sm, textAlignVertical: 'top' }}
          />
          <Field
            label="City (optional)"
            placeholder="e.g. Austin"
            value={city}
            onChangeText={setCity}
            maxLength={120}
          />
          <Button label="Create club" onPress={save} disabled={!canSave} loading={saving} />
          <Muted style={{ textAlign: 'left' }}>
            Clubs are open — anyone can find and join them. You&apos;ll be the first admin.
          </Muted>
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
});
