// Vollo design tokens. A bright, Strava-style "fresh court" aesthetic: light
// off-white feed, white elevated cards, and a tennis identity built from a rich
// grass/court green (the brand hero, used the way Strava uses orange) paired
// with an optic-yellow tennis-ball accent.

import type { Surface } from './types';

export const colors = {
  bg: '#F4F6F3', // light, faintly green-grey feed background
  surface: '#FFFFFF', // cards, sheets, nav + tab bars
  surfaceAlt: '#EDF1EC', // inputs, segmented controls, inactive chips
  border: '#E4E8E2', // hairline separators
  primary: '#0F7A3D', // grass/court green — the brand hero
  primaryDim: '#0A5E2E', // pressed / darker variant
  primarySoft: 'rgba(15, 122, 61, 0.12)', // soft green wash (active chips, win tag)
  onPrimary: '#FFFFFF', // text / icons on top of a primary fill
  accent: '#D7F205', // optic-yellow tennis ball — energetic accent
  accentSoft: 'rgba(215, 242, 5, 0.20)',
  onAccent: '#15241B', // dark text on top of an optic-yellow fill
  text: '#15241B', // near-black with a green undertone
  textDim: '#566159', // secondary copy
  textFaint: '#8A968D', // labels, timestamps, captions
  win: '#0F7A3D', // win = brand green
  loss: '#E04A3C', // warm coral-red, legible on light
  lossSoft: 'rgba(224, 74, 60, 0.12)',
  warning: '#E8990C', // amber (tiebreaks, long rallies)
  danger: '#E0432B',
  rival: '#8B7BD8', // opponents' territory on the map
  white: '#FFFFFF',
  black: '#0B130D',
} as const;

export const surfaceColors: Record<Surface, string> = {
  hard: '#2477C9', // blue hard court
  clay: '#C05B22', // terracotta
  grass: '#2E9E48', // green
  indoor: '#7E6CC4', // purple indoor
};

export const surfaceLabel: Record<Surface, string> = {
  hard: 'Hard',
  clay: 'Clay',
  grass: 'Grass',
  indoor: 'Indoor',
};

/** Soft (~13% alpha) surface fills for selected chips — centralised so screens
 * don't hand-build `${surfaceColors[s]}22` hex-alpha strings inline. */
export const surfaceColorsSoft: Record<Surface, string> = {
  hard: 'rgba(36, 119, 201, 0.13)',
  clay: 'rgba(192, 91, 34, 0.13)',
  grass: 'rgba(46, 158, 72, 0.13)',
  indoor: 'rgba(126, 108, 196, 0.13)',
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

// Soft elevation for white cards on the light feed — the subtle lift that gives
// the Strava activity feed its depth without heavy borders.
export const shadow = {
  card: {
    shadowColor: '#0B130D',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  bar: {
    shadowColor: '#0B130D',
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8,
  },
} as const;

/** Semi-transparent green fill for your territory polygons (≈20% opacity). */
export const TERRITORY_FILL = 'rgba(15, 122, 61, 0.20)';
export const TERRITORY_STROKE = '#0F7A3D';
