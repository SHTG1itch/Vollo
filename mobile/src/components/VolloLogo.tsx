// ── Vollo brand mark ────────────────────────────────────────────────────────
// The Vollo logotype: the word "Vollo" set in the brand display face (Barlow
// Semi Condensed Bold) with the FIRST "o" replaced by a tennis ball whose white
// seams curve like a swirl. The ball is tilted a touch so it reads with a little
// spin — energetic, unmistakably tennis, and clearly the hero "o" of the word.
//
// Geometry was tuned against a rendered preview (ratio 0.80, tilt -10°). Render
// is gated on the brand font at startup (App.tsx), so the letters never flash a
// system fallback next to the ball.
import React, { useId } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, Ellipse, Path, RadialGradient, Stop } from 'react-native-svg';
import { colors, fonts } from '../theme';

/**
 * The tennis-ball mark on its own — an optic-yellow ball with two white seam
 * curves and a soft top-left sheen. Reused as the "o" in the wordmark, as a
 * standalone app badge, and (wrapped in an Animated.View) as the spinning
 * splash/loader. `tilt` rotates the ball in place without affecting layout.
 */
export function TennisBall({
  size = 28,
  tilt = -10,
  style,
}: {
  size?: number;
  tilt?: number;
  style?: StyleProp<ViewStyle>;
}) {
  // Unique gradient id per instance — SVG gradient ids share a global namespace,
  // so two balls on screen would otherwise reference the same fill.
  const gid = 'vb' + useId().replace(/:/g, '');
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      style={[{ transform: [{ rotate: `${tilt}deg` }] }, style]}
    >
      <Defs>
        <RadialGradient id={gid} cx="36%" cy="30%" r="78%">
          <Stop offset="0" stopColor="#F3FF8C" />
          <Stop offset="0.48" stopColor="#D7F205" />
          <Stop offset="1" stopColor="#A8C200" />
        </RadialGradient>
      </Defs>
      {/* ball body */}
      <Circle cx="50" cy="50" r="47" fill={`url(#${gid})`} stroke="rgba(21,36,27,0.18)" strokeWidth={1.5} />
      {/* the two seams — the "swirl" that makes it a tennis ball */}
      <Path d="M26,12 C46,34 46,66 26,88" fill="none" stroke="#FFFFFF" strokeWidth={7.5} strokeLinecap="round" />
      <Path d="M74,12 C54,34 54,66 74,88" fill="none" stroke="#FFFFFF" strokeWidth={7.5} strokeLinecap="round" />
      {/* glossy highlight */}
      <Ellipse cx="36" cy="32" rx="17" ry="11" fill="#FFFFFF" opacity={0.16} />
    </Svg>
  );
}

/**
 * The full "Vollo" logotype. `size` is the cap height of the letters in px;
 * everything else (ball diameter, kerning, baseline drop) scales from it.
 */
export function VolloWordmark({
  size = 30,
  color = colors.text,
  tilt = -10,
  style,
}: {
  size?: number;
  /** Colour of the letters (the ball keeps its optic-yellow fill). */
  color?: string;
  tilt?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const ballSize = Math.round(size * 0.8);
  const kern = size * 0.02; // snug the ball between V and llo
  const letter = {
    fontFamily: fonts.display,
    fontSize: size,
    lineHeight: size,
    color,
    letterSpacing: -size * 0.02,
  } as const;
  return (
    <View
      accessibilityRole="header"
      accessibilityLabel="Vollo"
      style={[styles.row, style]}
    >
      <Text allowFontScaling={false} style={letter}>
        V
      </Text>
      <View style={{ marginHorizontal: -kern }}>
        <TennisBall size={ballSize} tilt={tilt} />
      </View>
      <Text allowFontScaling={false} style={letter}>
        llo
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
