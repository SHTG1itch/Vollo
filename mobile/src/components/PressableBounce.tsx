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
  ...rest
}: PressableProps & { children: React.ReactNode; style?: StyleProp<ViewStyle>; scaleTo?: number }) {
  const scale = useSharedValue(1);
  const aStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      onPressIn={() => {
        scale.value = withSpring(scaleTo, { damping: 15, stiffness: 320 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 12, stiffness: 260 });
      }}
      style={[aStyle, style]}
      {...rest}
    >
      {children}
    </AnimatedPressable>
  );
}
