// Vollo design tokens. Dark, court-at-night aesthetic with neon tennis-green
// accents — the same #32CD32 lime the domination polygons use on the map.

import type { Surface } from './types';

export const colors = {
  bg: '#0B141A',
  surface: '#13212B',
  surfaceAlt: '#1B2C38',
  border: '#243845',
  primary: '#32CD32', // neon tennis green
  primaryDim: '#2BA52B',
  primarySoft: 'rgba(50, 205, 50, 0.16)',
  accent: '#E8FF59', // tennis-ball yellow-green
  text: '#EAF2F0',
  textDim: '#9DB2BD',
  textFaint: '#5E7787',
  win: '#32CD32',
  loss: '#FF6B6B',
  warning: '#FFC857',
  danger: '#FF5C5C',
  white: '#FFFFFF',
  black: '#000000',
} as const;

export const surfaceColors: Record<Surface, string> = {
  hard: '#2E86DE', // blue hard court
  clay: '#D2691E', // terracotta
  grass: '#3FA34D', // green
  indoor: '#8E7CC3', // purple indoor
};

export const surfaceLabel: Record<Surface, string> = {
  hard: 'Hard',
  clay: 'Clay',
  grass: 'Grass',
  indoor: 'Indoor',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 999,
} as const;

export const font = {
  h1: 28,
  h2: 22,
  h3: 18,
  body: 15,
  small: 13,
  tiny: 11,
} as const;

/** Semi-transparent neon-green fill for the territory polygons (≈20% opacity). */
export const TERRITORY_FILL = 'rgba(50, 205, 50, 0.20)';
export const TERRITORY_STROKE = '#32CD32';
