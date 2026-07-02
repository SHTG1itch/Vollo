// In-app toast — the non-blocking feedback layer Strava uses where this app
// previously threw OS Alert.alert modals. showToast() can be called from any
// screen or store; <ToastHost /> (mounted once in App.tsx, above navigation)
// renders the queue top-of-screen with a spring slide-in.
import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, { FadeOutUp, SlideInUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';
import { colors, font, fonts, radius, shadow, spacing } from '../theme';

export type ToastType = 'success' | 'error' | 'info';

interface ToastState {
  message: string | null;
  type: ToastType;
  /** Bumped on every show so an identical message still restarts the timer. */
  nonce: number;
  show: (message: string, type?: ToastType) => void;
  hide: () => void;
}

const useToast = create<ToastState>()((set) => ({
  message: null,
  type: 'info',
  nonce: 0,
  show: (message, type = 'info') => set((s) => ({ message, type, nonce: s.nonce + 1 })),
  hide: () => set({ message: null }),
}));

/** Show a transient, non-blocking toast. Safe to call from anywhere. */
export function showToast(message: string, type: ToastType = 'info'): void {
  useToast.getState().show(message, type);
}

const DURATION_MS = 2_600;
// Errors get a little longer — the user may want to actually read them.
const ERROR_DURATION_MS = 4_000;

const ACCENT: Record<ToastType, string> = {
  success: colors.primary,
  error: colors.danger,
  info: colors.text,
};

export function ToastHost() {
  const insets = useSafeAreaInsets();
  const { message, type, nonce, hide } = useToast();

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(hide, type === 'error' ? ERROR_DURATION_MS : DURATION_MS);
    return () => clearTimeout(t);
  }, [message, type, nonce, hide]);

  if (!message) return null;
  return (
    <Animated.View
      key={nonce}
      entering={SlideInUp.springify().damping(18).stiffness(220)}
      exiting={FadeOutUp.duration(160)}
      style={[styles.wrap, { top: insets.top + spacing.sm }]}
      pointerEvents="box-none"
    >
      <Pressable
        onPress={hide}
        style={[styles.toast, { borderLeftColor: ACCENT[type] }]}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
      >
        <Text style={styles.text} numberOfLines={3}>
          {message}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 1000,
    alignItems: 'center',
  },
  toast: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 4,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    maxWidth: 520,
    width: '100%',
    ...shadow.card,
  },
  text: { color: colors.text, fontSize: font.small, fontFamily: fonts.medium, textAlign: 'left' },
});
