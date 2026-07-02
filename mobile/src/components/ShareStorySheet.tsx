// ── Share-to-story sheet ─────────────────────────────────────────────────────
// A full-screen modal that previews the MatchShareCard and rasterises it with
// react-native-view-shot's captureRef, then hands the local image URI to the
// native share sheet (expo-sharing) — the user picks Instagram Stories, Snapchat,
// Messages, Save, etc. A secondary action copies the image to the clipboard
// (expo-clipboard) so it can be pasted anywhere. No native code, works in a dev
// build / Expo Go: the capture is a plain view-to-PNG/JPEG rasterisation.
//
// The on-screen preview is sized to fit the sheet, but the capture targets a
// SEPARATE, off-screen card rendered at story resolution so the exported image
// is crisp at 1080-wide stories regardless of how small the preview is.
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import { MatchShareCard, SHARE_ASPECT, type ShareVariant } from './MatchShareCard';
import { Button } from './ui';
import { showToast } from './Toast';
import { colors, fonts, radius, spacing } from '../theme';
import type { MatchCard } from '../types';

// Off-screen capture width (logical px). At a 2x–3x device scale this rasterises
// to ~1080–1620px wide — crisp for a 1080-wide Instagram/Snapchat story.
const CAPTURE_W = 540;

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

  const needsPhoto = variant === 'photo' && hasPhoto;
  // Capture must wait for the background photo to decode, else view-shot snapshots
  // an empty photo region. Non-photo variants are ready immediately.
  const [photoReady, setPhotoReady] = useState(!needsPhoto);
  const canCapture = photoReady;

  // Reset readiness whenever the photo target changes or the sheet (re)opens, and
  // clear any stale "copied" note on open.
  useEffect(() => {
    setPhotoReady(!(variant === 'photo' && hasPhoto));
  }, [visible, variant, hasPhoto]);
  useEffect(() => {
    if (visible) setNote(null);
  }, [visible]);

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
    if (busy || !canCapture) return;
    setBusy('share');
    setNote(null);
    try {
      const uri = await rasterize('tmpfile');
      if (!(await Sharing.isAvailableAsync())) {
        showToast('This device can’t open the share sheet.', 'error');
        return;
      }
      await Sharing.shareAsync(uri, {
        mimeType: isPng ? 'image/png' : 'image/jpeg',
        UTI: isPng ? 'public.png' : 'public.jpeg',
        dialogTitle: 'Share your match to a story',
      });
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not create the image — please try again.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function onCopy() {
    if (busy || !canCapture) return;
    setBusy('copy');
    setNote(null);
    try {
      const b64 = await rasterize('base64');
      await Clipboard.setImageAsync(b64);
      setNote('Copied to clipboard — paste it into any story or chat.');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not copy the image — please try again.', 'error');
    } finally {
      setBusy(null);
    }
  }

  // Don't tear the sheet down (and unmount the capture view) mid-capture.
  const handleClose = () => {
    if (busy) return;
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose} statusBarTranslucent>
      {/* The sheet backdrop is near-black — flip to light status icons while
          it's open (reverts automatically when the modal unmounts this). */}
      <StatusBar style="light" />
      <View style={[styles.backdrop, { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.lg }]}>
        <View style={styles.header}>
          <Text style={styles.title}>Share to story</Text>
          <Pressable
            onPress={handleClose}
            disabled={!!busy}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={[styles.close, !!busy && { opacity: 0.4 }]}
          >
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>

        <View style={styles.previewArea}>
          <View style={[styles.previewFrame, { width: previewW, height: previewW * SHARE_ASPECT, borderRadius: radius.lg }]}>
            <MatchShareCard match={match} width={previewW} variant={variant} />
          </View>
        </View>

        {/* Off-screen, story-resolution capture target. Rendered (not display:none)
            so it's laid out and view-shot can rasterise it; collapsable=false keeps
            it a real native view on Android. */}
        <View
          ref={cardRef}
          collapsable={false}
          pointerEvents="none"
          style={styles.captureHost}
        >
          <MatchShareCard
            match={match}
            width={CAPTURE_W}
            variant={variant}
            onPhotoLoad={() => setPhotoReady(true)}
          />
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
          <Button
            label="Share to story"
            onPress={onShare}
            loading={busy === 'share'}
            disabled={!!busy || !canCapture}
            style={styles.shareBtn}
          />
          <Pressable
            onPress={onCopy}
            disabled={!!busy || !canCapture}
            style={({ pressed }) => [styles.copyBtn, pressed && { opacity: 0.7 }, (!!busy || !canCapture) && { opacity: 0.5 }]}
          >
            {busy === 'copy' ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.copyText}>Copy image</Text>
            )}
          </Pressable>
        </View>

        <Text style={styles.hint} numberOfLines={2}>
          {note ??
            (!canCapture
              ? 'Preparing your photo…'
              : 'Opens your share sheet — pick Instagram, Snapchat, Messages or Save.')}
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
  closeText: { color: colors.white, fontSize: 16, fontFamily: fonts.bold },
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
  // Parked far off-screen so the user never sees it, but kept fully opaque and
  // laid out — view-shot rasterises the layer, and opacity:0 would blank it.
  captureHost: { position: 'absolute', left: -100000, top: 0 },
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
