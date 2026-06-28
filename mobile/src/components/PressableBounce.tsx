// Springy press micro-interaction (echoes 21st.dev "Animated/Magnetic Button").
// Scale dips on press-in and springs back on release — gives taps real tactility.
import React from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function PressableBounce({
  children,
  style,
  scaleTo = 0.94,
  onPressIn,
  onPressOut,
  ...rest
}: PressableProps & { children: React.ReactNode; style?: StyleProp<ViewStyle>; scaleTo?: number }) {
  const scale = useSharedValue(1);
  const aStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  // Spread rest first and compose any consumer onPressIn/onPressOut so the
  // bounce can never be silently clobbered by a passed-through handler.
  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        scale.value = withSpring(scaleTo, { damping: 15, stiffness: 320 });
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.value = withSpring(1, { damping: 12, stiffness: 260 });
        onPressOut?.(e);
      }}
      style={[aStyle, style]}
    >
      {children}
    </AnimatedPressable>
  );
}
