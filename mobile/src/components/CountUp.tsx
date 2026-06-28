// Animated count-up number (echoes 21st.dev / Magic UI "Number Ticker").
// Tweens from the previous value to the new one on the UI thread — used for hero
// stats like the Vollo rating, streak weeks, and profile counts.
//
// RN-correct detail: you cannot mutate a <Text>'s children from a worklet, so we
// animate the `text` prop of a TextInput via useAnimatedProps. That keeps the
// per-frame string update on the UI thread (no React re-render per frame).
import React, { useEffect } from 'react';
import { TextInput, type StyleProp, type TextStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

// The `text` prop of a TextInput is animatable out of the box in reanimated —
// no addWhitelistedNativeProps needed.
const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

// Worklet-safe number formatting (toLocaleString isn't reliable in the worklet
// runtime) — manual thousands grouping + fixed decimals.
function format(n: number, decimals: number, prefix: string, suffix: string): string {
  'worklet';
  const fixed = Math.abs(n).toFixed(decimals);
  const [intPart, frac] = fixed.split('.');
  let grouped = '';
  for (let i = 0; i < intPart.length; i++) {
    if (i > 0 && (intPart.length - i) % 3 === 0) grouped += ',';
    grouped += intPart[i];
  }
  const sign = n < 0 ? '-' : '';
  return prefix + sign + grouped + (frac ? '.' + frac : '') + suffix;
}

export function CountUp({
  value,
  decimals = 0,
  duration = 900,
  prefix = '',
  suffix = '',
  style,
}: {
  value: number;
  decimals?: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  style?: StyleProp<TextStyle>;
}) {
  const reduced = useReducedMotion();
  const from = useSharedValue(value);
  const to = useSharedValue(value);
  const progress = useSharedValue(1);

  useEffect(() => {
    if (reduced) {
      from.value = value;
      to.value = value;
      progress.value = 1;
      return;
    }
    from.value = to.value; // start from whatever is on screen
    to.value = value;
    progress.value = 0;
    progress.value = withTiming(1, { duration, easing: Easing.out(Easing.cubic) });
  }, [value, duration, reduced, from, to, progress]);

  const animatedProps = useAnimatedProps(() => {
    const current = from.value + (to.value - from.value) * progress.value;
    const text = format(current, decimals, prefix, suffix);
    // `defaultValue` keeps the input uncontrolled; `text` drives the live value.
    return { text, defaultValue: text } as Partial<{ text: string; defaultValue: string }>;
  });

  return (
    <AnimatedTextInput
      editable={false}
      pointerEvents="none"
      underlineColorAndroid="transparent"
      style={[{ padding: 0 }, style]}
      animatedProps={animatedProps}
    />
  );
}
