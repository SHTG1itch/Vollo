// Confetti / celebration burst (echoes 21st.dev / Magic UI "Confetti").
// ~26 physics-launched pieces in Vollo's palette shoot up, arc under gravity,
// spin, and fade. Fired on a logged win and on a new territory capture.
//
// Performance: every piece is driven by ONE shared `progress` value (0→1); each
// piece reads it in its own useAnimatedStyle plus its own closure constants, so
// the JS thread never touches per-particle state and the hook count is fixed.
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

const COLORS = ['#D7F205', '#0F7A3D', '#2E9E48', '#FFFFFF', '#E8990C'];
const COUNT = 26;
const DURATION = 1500;

type Piece = {
  vx: number;
  vy: number;
  g: number;
  size: number;
  rot: number;
  spin: number;
  color: string;
  round: boolean;
};

function buildPieces(width: number, seed: number): Piece[] {
  // Deterministic pseudo-random (no Math.random — varies by index + seed).
  const rand = (i: number) => {
    const x = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return Array.from({ length: COUNT }, (_, i) => ({
    vx: (rand(i) - 0.5) * width * 1.1,
    vy: -(360 + rand(i + 100) * 320),
    g: 1400 + rand(i + 200) * 500,
    size: 7 + rand(i + 300) * 7,
    rot: rand(i + 400) * 360,
    spin: (rand(i + 500) - 0.5) * 1080,
    color: COLORS[Math.floor(rand(i + 600) * COLORS.length)]!,
    round: rand(i + 700) < 0.4,
  }));
}

function ConfettiPiece({
  piece,
  progress,
  originX,
  originY,
}: {
  piece: Piece;
  progress: SharedValue<number>;
  originX: number;
  originY: number;
}) {
  const style = useAnimatedStyle(() => {
    const p = progress.value;
    const x = piece.vx * p;
    const y = piece.vy * p + 0.5 * piece.g * p * p; // projectile arc
    return {
      opacity: interpolate(p, [0, 0.7, 1], [1, 1, 0]),
      transform: [
        { translateX: x },
        { translateY: y },
        { rotate: `${piece.rot + piece.spin * p}deg` },
        { scale: interpolate(p, [0, 0.1, 1], [0.4, 1, 1]) },
      ],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: originX,
          top: originY,
          width: piece.size,
          height: piece.size,
          backgroundColor: piece.color,
          borderRadius: piece.round ? piece.size / 2 : 2,
        },
        style,
      ]}
    />
  );
}

/**
 * Fire a one-shot confetti burst. Flip `play` true to fire; bump the `key` to
 * replay. No-ops under reduce-motion. `onDone` fires when the burst finishes.
 */
export function ConfettiBurst({ play, onDone }: { play: boolean; onDone?: () => void }) {
  const { width, height } = useWindowDimensions();
  const progress = useSharedValue(0);
  const reduced = useReducedMotion();
  const pieces = useMemo(() => buildPieces(width, Math.round(width + height)), [width, height]);
  const originX = width / 2;
  const originY = height * 0.4;

  // Keep onDone in a ref so the one-shot launch effect doesn't depend on the
  // (usually inline) callback's identity — otherwise an unrelated re-render of
  // the host screen during the ~1.5s burst would restart it from the origin.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const notifyDone = useCallback(() => onDoneRef.current?.(), []);

  useEffect(() => {
    if (!play) return;
    if (reduced) {
      notifyDone();
      return;
    }
    progress.value = 0;
    progress.value = withTiming(1, { duration: DURATION, easing: Easing.out(Easing.quad) }, (finished) => {
      'worklet';
      if (finished) runOnJS(notifyDone)();
    });
  }, [play, reduced, progress, notifyDone]);

  if (!play || reduced) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {pieces.map((piece, i) => (
        <ConfettiPiece key={i} piece={piece} progress={progress} originX={originX} originY={originY} />
      ))}
    </View>
  );
}
