// ── Share-to-story sheet ─────────────────────────────────────────────────────
// A full-screen modal that previews the MatchShareCard and rasterises it with
// react-native-view-shot's captureRef, then hands the local image URI to the
// native share sheet (expo-sharing) — the user picks Instagram Stories, Snapchat,
// Messages, Save, etc. A secondary action copies the image to the clipboard
// (expo-clipboard) so it can be pasted anywhere. No native code, works in a dev
// build / Expo Go: the capture is a plain view-to-PNG/JPEG rasterisation.
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import { MatchShareCard, SHARE_ASPECT, type ShareVariant } from './MatchShareCard';
import { Button } from './ui';
import { colors, fonts, radius, spacing } from '../theme';
import type { MatchCard } from '../types';

export function ShareStorySheet({
  match,
  visible,
  onClose,
}: {
  match: MatchCard;
  visible: boolean;
  onClose: () => void;
}) {
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const cardRef = useRef<View>(null);
  const hasPhoto = !!match.photo_url;
  const [variant, setVariant] = useState<ShareVariant>(hasPhoto ? 'photo' : 'court');
  const [busy, setBusy] = useState<null | 'share' | 'copy'>(null);
  const [note, setNote] = useState<string | null>(null);

  // Size the preview to fit between the header and the controls, keeping 9:16.
  const chromeH = 320 + insets.top + insets.bottom; // header + toggle + buttons
  const maxByHeight = (winH - chromeH) / SHARE_ASPECT;
  const previewW = Math.max(180, Math.min(winW - spacing.xl * 2, maxByHeight, 340));
  const isPng = variant === 'sticker';

  const options = ([
    hasPhoto ? { label: 'Photo', value: 'photo' as const } : null,
    { label: 'Court', value: 'court' as const },
    { label: 'Sticker', value: 'sticker' as const },
  ].filter(Boolean)) as { label: string; value: ShareVariant }[];

  async function rasterize(result: 'tmpfile' | 'base64') {
    return captureRef(cardRef, {
      format: isPng ? 'png' : 'jpg',
      quality: 0.95,
      result,
    });
  }

  async function onShare() {
    if (busy) return;
    setBusy('share');
    setNote(null);
    try {
      const uri = await rasterize('tmpfile');
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device can’t open the share sheet.');
        return;
      }
      await Sharing.shareAsync(uri, {
        mimeType: isPng ? 'image/png' : 'image/jpeg',
        UTI: isPng ? 'public.png' : 'public.jpeg',
        dialogTitle: 'Share your match to a story',
      });
    } catch (e) {
      Alert.alert('Could not create image', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(null);
    }
  }

  async function onCopy() {
    if (busy) return;
    setBusy('copy');
    setNote(null);
    try {
      const b64 = await rasterize('base64');
      await Clipboard.setImageAsync(b64);
      setNote('Copied to clipboard — paste it into any story or chat.');
    } catch (e) {
      Alert.alert('Could not copy image', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.backdrop, { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.lg }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Share to story</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close" style={styles.close}>
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>

        <View style={styles.previewArea}>
          <View style={[styles.previewFrame, { width: previewW, height: previewW * SHARE_ASPECT, borderRadius: radius.lg }]}>
            {/* The capture target — the card at preview resolution. collapsable=false
                keeps it a real native view so view-shot can rasterise it on Android. */}
            <View ref={cardRef} collapsable={false}>
              <MatchShareCard match={match} width={previewW} variant={variant} />
            </View>
          </View>
        </View>

        {options.length > 1 ? (
          <View style={styles.toggle}>
            {options.map((opt) => {
              const active = opt.value === variant;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => setVariant(opt.value)}
                  style={[styles.toggleItem, active && styles.toggleItemActive]}
                >
                  <Text style={[styles.toggleText, active && styles.toggleTextActive]}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <View style={styles.actions}>
          <Button label="Share to story" onPress={onShare} loading={busy === 'share'} disabled={!!busy} style={styles.shareBtn} />
          <Pressable
            onPress={onCopy}
            disabled={!!busy}
            style={({ pressed }) => [styles.copyBtn, pressed && { opacity: 0.7 }, !!busy && { opacity: 0.5 }]}
          >
            {busy === 'copy' ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.copyText}>Copy image</Text>
            )}
          </Pressable>
        </View>

        <Text style={styles.hint} numberOfLines={2}>
          {note ?? 'Opens your share sheet — pick Instagram, Snapchat, Messages or Save.'}
        </Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(7,12,9,0.96)', paddingHorizontal: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm },
  title: { color: colors.white, fontFamily: fonts.display, fontSize: 22, letterSpacing: 0.3 },
  close: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.12)' },
  closeText: { color: colors.white, fontSize: 16, fontWeight: '700' },
  previewArea: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.md },
  previewFrame: {
    backgroundColor: colors.black,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  toggle: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: radius.md, padding: 3, alignSelf: 'center', marginBottom: spacing.md },
  toggleItem: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.sm },
  toggleItemActive: { backgroundColor: colors.primary },
  toggleText: { color: 'rgba(255,255,255,0.7)', fontFamily: fonts.bold, fontSize: 13 },
  toggleTextActive: { color: colors.white },
  actions: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
  shareBtn: { flex: 1 },
  copyBtn: {
    height: 50,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 120,
  },
  copyText: { color: colors.white, fontFamily: fonts.bold, fontSize: 15, letterSpacing: 0.3 },
  hint: { color: 'rgba(255,255,255,0.55)', fontSize: 12, textAlign: 'center', marginTop: spacing.md, fontFamily: fonts.body, minHeight: 32 },
});
