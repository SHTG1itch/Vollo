// Animated Vollo tennis-ball mark (echoes 21st.dev "Pulsating loader" / orbit
// spinners). Reuses the static TennisBall art so the brand stays consistent,
// wrapping it in an Animated.View that gently breathes and spins. Used as the
// splash/loading brand and as an in-app loading indicator.
import React, { useEffect } from 'react';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { TennisBall } from './VolloLogo';

export function BallSpinner({
  size = 72,
  mode = 'loop',
}: {
  size?: number;
  /** 'loop' = continuous breathe + spin; 'splash' = one decisive spin-up. */
  mode?: 'loop' | 'splash';
}) {
  const scale = useSharedValue(1);
  const spin = useSharedValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) return;
    scale.value = withRepeat(
      withSequence(
        withTiming(1.08, { duration: 700, easing: Easing.inOut(Easing.sin) }),
        withTiming(1.0, { duration: 700, easing: Easing.inOut(Easing.sin) }),
      ),
      -1,
      true,
    );
    if (mode === 'splash') {
      spin.value = withSequence(
        withTiming(360, { duration: 650, easing: Easing.out(Easing.cubic) }),
        withSpring(345, { damping: 6, stiffness: 90 }),
      );
    } else {
      spin.value = withRepeat(withTiming(360, { duration: 2600, easing: Easing.linear }), -1, false);
    }
  }, [scale, spin, mode, reduced]);

  const style = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }, { rotate: `${spin.value}deg` }],
  }));

  // tilt={0}: the wrapper owns rotation, so the ball art stays upright at rest.
  return (
    <Animated.View style={style}>
      <TennisBall size={size} tilt={0} />
    </Animated.View>
  );
}
