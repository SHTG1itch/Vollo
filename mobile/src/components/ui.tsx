import React from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { colors, font, fonts, radius, shadow, spacing } from '../theme';
import { CountUp } from './CountUp';
import { PressableBounce } from './PressableBounce';

export function Screen({
  children,
  edges = ['top'],
  style,
}: {
  children: React.ReactNode;
  edges?: Edge[];
  style?: ViewStyle;
}) {
  return (
    <SafeAreaView edges={edges} style={[styles.screen, style]}>
      {children}
    </SafeAreaView>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  const isPrimary = variant === 'primary';
  const isDanger = variant === 'danger';
  return (
    <PressableBounce
      onPress={onPress}
      disabled={disabled || loading}
      style={[
        styles.btn,
        isPrimary && styles.btnPrimary,
        variant === 'secondary' && styles.btnSecondary,
        variant === 'ghost' && styles.btnGhost,
        isDanger && styles.btnDanger,
        (disabled || loading) && styles.btnDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={isPrimary ? colors.onPrimary : colors.primary} />
      ) : (
        <Text
          style={[
            styles.btnText,
            isPrimary && { color: colors.onPrimary },
            (variant === 'ghost' || variant === 'secondary') && { color: colors.primary },
            isDanger && { color: colors.white },
          ]}
        >
          {label}
        </Text>
      )}
    </PressableBounce>
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: spacing.xs }}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.textFaint}
        style={[styles.input, style]}
        {...rest}
      />
    </View>
  );
}

export function Badge({
  label,
  color = colors.primary,
  filled,
}: {
  label: string;
  color?: string;
  filled?: boolean;
}) {
  return (
    <View
      style={[
        styles.badge,
        filled ? { backgroundColor: color } : { borderColor: color, borderWidth: 1 },
      ]}
    >
      <Text style={[styles.badgeText, { color: filled ? colors.white : color }]}>{label}</Text>
    </View>
  );
}

export function Avatar({ name, uri, size = 40 }: { name: string; uri?: string | null; size?: number }) {
  const dims = { width: size, height: size, borderRadius: size / 2 };
  // Real photo when we have one — falling back to initials only when absent.
  if (uri && uri.trim()) {
    return (
      <Image
        source={{ uri }}
        style={[styles.avatar, dims]}
        accessibilityLabel={name}
        accessibilityIgnoresInvertColors
      />
    );
  }
  const initials =
    (name ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '🎾';
  return (
    <View style={[styles.avatar, dims]} accessibilityLabel={name}>
      <Text style={[styles.avatarText, { fontSize: size * 0.4 }]}>{initials}</Text>
    </View>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segment}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            style={[styles.segmentItem, active && styles.segmentItemActive]}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary} size="large" />
      {label ? <Text style={styles.dim}>{label}</Text> : null}
    </View>
  );
}

export function EmptyState({
  icon = '🎾',
  title,
  subtitle,
  action,
}: {
  icon?: string;
  title: string;
  subtitle?: string;
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.center}>
      <Text style={{ fontSize: 48, marginBottom: spacing.md }}>{icon}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.dim}>{subtitle}</Text> : null}
      {action ? (
        <Button label={action.label} onPress={action.onPress} style={{ marginTop: spacing.lg, minWidth: 200 }} />
      ) : null}
    </View>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: {
  title?: string;
  message?: string | null;
  onRetry?: () => void;
}) {
  return (
    <View style={styles.center}>
      <Text style={{ fontSize: 48, marginBottom: spacing.md }}>⚠️</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      {message ? <Text style={styles.dim}>{message}</Text> : null}
      {onRetry ? (
        <Button label="Try again" variant="secondary" onPress={onRetry} style={{ marginTop: spacing.md, minWidth: 160 }} />
      ) : null}
    </View>
  );
}

export function Stat({ label, value, color = colors.text }: { label: string; value: string | number; color?: string }) {
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      {typeof value === 'number' ? (
        <CountUp value={value} style={[styles.statValue, { color, textAlign: 'center', width: '100%' }]} />
      ) : (
        <Text style={[styles.statValue, { color }]}>{value}</Text>
      )}
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export function H1({ children }: { children: React.ReactNode }) {
  return <Text style={styles.h1}>{children}</Text>;
}
export function H2({ children }: { children: React.ReactNode }) {
  return <Text style={styles.h2}>{children}</Text>;
}
export function Muted({ children, style }: { children: React.ReactNode; style?: object }) {
  return <Text style={[styles.dim, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
  btn: {
    height: 50,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  btnPrimary: { backgroundColor: colors.primary },
  btnSecondary: { backgroundColor: colors.primarySoft },
  btnGhost: { backgroundColor: 'transparent' },
  btnDanger: { backgroundColor: colors.danger },
  btnDisabled: { opacity: 0.45 },
  btnText: { fontSize: font.body, fontFamily: fonts.bold, letterSpacing: 0.3 },
  label: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.bold, marginLeft: 2 },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 48,
    color: colors.text,
    fontSize: font.body,
    fontFamily: fonts.body,
    borderWidth: 1,
    borderColor: colors.border,
  },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill, alignSelf: 'flex-start' },
  badgeText: { fontSize: font.tiny, fontFamily: fonts.bold },
  avatar: { backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.primary, fontFamily: fonts.display },
  segment: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: 3,
  },
  segmentItem: { flex: 1, paddingVertical: spacing.sm, alignItems: 'center', borderRadius: radius.sm },
  segmentItemActive: { backgroundColor: colors.primary },
  segmentText: { color: colors.textDim, fontFamily: fonts.bold, fontSize: font.small },
  segmentTextActive: { color: colors.onPrimary, fontFamily: fonts.bold },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.xs },
  dim: { color: colors.textDim, fontSize: font.small, fontFamily: fonts.body, textAlign: 'center' },
  emptyTitle: { color: colors.text, fontSize: font.h3, fontFamily: fonts.heading },
  statValue: { fontSize: font.h1, fontFamily: fonts.display },
  statLabel: { color: colors.textFaint, fontSize: font.tiny, fontFamily: fonts.bold, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  h1: { color: colors.text, fontSize: font.h1 + 2, fontFamily: fonts.display, letterSpacing: 0.3 },
  h2: { color: colors.text, fontSize: font.h2, fontFamily: fonts.display, letterSpacing: 0.2 },
});
