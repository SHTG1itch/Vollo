/** Instagram/Snapchat story output dimensions in physical pixels. */
export const STORY_PIXEL_WIDTH = 1080;
export const STORY_PIXEL_HEIGHT = 1920;

/**
 * react-native-view-shot measures requested dimensions in logical pixels and
 * multiplies them by the device pixel ratio. Convert the desired physical story
 * size so every device emits the same 1080×1920 asset without wasting memory.
 */
export function storyCaptureSize(pixelRatio: number): { width: number; height: number } {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  return { width: STORY_PIXEL_WIDTH / ratio, height: STORY_PIXEL_HEIGHT / ratio };
}

/** expo-sharing requires a local file URL; view-shot versions differ here. */
export function asFileUri(uri: string): string {
  return uri.startsWith('file://') ? uri : `file://${uri}`;
}

export function captureIsReady({
  key,
  laidOutKey,
  photoReadyKey,
  photoFailedKey,
  needsPhoto,
}: {
  key: string;
  laidOutKey: string | null;
  photoReadyKey: string | null;
  photoFailedKey: string | null;
  needsPhoto: boolean;
}): boolean {
  return laidOutKey === key && photoFailedKey !== key && (!needsPhoto || photoReadyKey === key);
}
