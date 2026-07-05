// Haptic feedback for key interactions (kudos, chip selection, match logged…).
//
// Lazy-required with a try/catch — same pattern as lib/oauth.ts — so a binary
// built before expo-haptics was added (an older dev client) degrades to a
// silent no-op instead of crashing at import time. All calls are fire-and-
// forget: haptics must never fail an interaction.
type HapticsModule = typeof import('expo-haptics');

let mod: HapticsModule | null | undefined;
function load(): HapticsModule | null {
  if (mod !== undefined) return mod;
  try {
    // Deliberate lazy require: a synchronous dynamic import() isn't possible,
    // and this must not run the native bootstrap at module-evaluation time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-haptics') as HapticsModule;
  } catch {
    mod = null;
  }
  return mod;
}

/** A light tick — selection changes, chips, kudos taps. */
export function tapLight(): void {
  const h = load();
  if (h) void h.impactAsync(h.ImpactFeedbackStyle.Light).catch(() => {});
}

/** A firmer tap — primary actions (follow, verify, send challenge). */
export function tapMedium(): void {
  const h = load();
  if (h) void h.impactAsync(h.ImpactFeedbackStyle.Medium).catch(() => {});
}

/** Success notification — match logged, challenge sent, profile saved. */
export function notifySuccess(): void {
  const h = load();
  if (h) void h.notificationAsync(h.NotificationFeedbackType.Success).catch(() => {});
}

/** Error notification — a submit that failed. */
export function notifyError(): void {
  const h = load();
  if (h) void h.notificationAsync(h.NotificationFeedbackType.Error).catch(() => {});
}
