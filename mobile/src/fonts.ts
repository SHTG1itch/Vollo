// Vollo's bundled custom typeface (Barlow / Barlow Semi Condensed, OFL).
// Registered under Vollo-branded family names so the rest of the app refers to
// them via the `fonts` map in theme.ts. Loaded once at startup by App.tsx with
// expo-font's useFonts — render is gated until these resolve so text never
// flashes from a system fallback into the brand face.
export const FONT_ASSETS = {
  'Vollo-Display': require('../assets/fonts/Vollo-Display.ttf'),
  'Vollo-Heading': require('../assets/fonts/Vollo-Heading.ttf'),
  'Vollo-Body': require('../assets/fonts/Vollo-Body.ttf'),
  'Vollo-BodyMedium': require('../assets/fonts/Vollo-BodyMedium.ttf'),
  'Vollo-BodyBold': require('../assets/fonts/Vollo-BodyBold.ttf'),
} as const;
