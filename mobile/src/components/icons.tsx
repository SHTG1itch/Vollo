// Vollo's vector icon set, drawn with react-native-svg (already a native dep,
// so this adds no new module and keeps Expo Go working). Feather-style 24px
// stroke icons — crisp at tab-bar and toolbar sizes where the previous emoji
// glyphs rendered inconsistently across platforms.
import React from 'react';
import Svg, { Circle, Line, Path, Polygon, Polyline } from 'react-native-svg';
import { colors } from '../theme';

export type IconName =
  | 'home'
  | 'map'
  | 'plus'
  | 'plus-circle'
  | 'bell'
  | 'user'
  | 'search'
  | 'locate'
  | 'users'
  | 'chevron-left';

export function Icon({
  name,
  size = 22,
  color = colors.text,
  strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const common = {
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none' as const,
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === 'home' && (
        <>
          <Path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" {...common} />
          <Polyline points="9 22 9 12 15 12 15 22" {...common} />
        </>
      )}
      {name === 'map' && (
        <>
          <Polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" {...common} />
          <Line x1="8" y1="2" x2="8" y2="18" {...common} />
          <Line x1="16" y1="6" x2="16" y2="22" {...common} />
        </>
      )}
      {name === 'plus' && (
        <>
          <Line x1="12" y1="5" x2="12" y2="19" {...common} />
          <Line x1="5" y1="12" x2="19" y2="12" {...common} />
        </>
      )}
      {name === 'plus-circle' && (
        <>
          <Circle cx="12" cy="12" r="10" {...common} />
          <Line x1="12" y1="8" x2="12" y2="16" {...common} />
          <Line x1="8" y1="12" x2="16" y2="12" {...common} />
        </>
      )}
      {name === 'bell' && (
        <>
          <Path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" {...common} />
          <Path d="M13.73 21a2 2 0 0 1-3.46 0" {...common} />
        </>
      )}
      {name === 'user' && (
        <>
          <Path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" {...common} />
          <Circle cx="12" cy="7" r="4" {...common} />
        </>
      )}
      {name === 'search' && (
        <>
          <Circle cx="11" cy="11" r="8" {...common} />
          <Line x1="21" y1="21" x2="16.65" y2="16.65" {...common} />
        </>
      )}
      {name === 'locate' && (
        <>
          <Circle cx="12" cy="12" r="7" {...common} />
          <Circle cx="12" cy="12" r="1.5" fill={color} stroke="none" />
          <Line x1="12" y1="2" x2="12" y2="5" {...common} />
          <Line x1="12" y1="19" x2="12" y2="22" {...common} />
          <Line x1="2" y1="12" x2="5" y2="12" {...common} />
          <Line x1="19" y1="12" x2="22" y2="12" {...common} />
        </>
      )}
      {name === 'users' && (
        <>
          <Path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" {...common} />
          <Circle cx="9" cy="7" r="4" {...common} />
          <Path d="M23 21v-2a4 4 0 0 0-3-3.87" {...common} />
          <Path d="M16 3.13a4 4 0 0 1 0 7.75" {...common} />
        </>
      )}
      {name === 'chevron-left' && <Polyline points="15 18 9 12 15 6" {...common} />}
    </Svg>
  );
}
