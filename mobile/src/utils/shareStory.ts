/** Instagram/Snapchat story output dimensions in physical pixels. */
export const STORY_PIXEL_WIDTH = 1080;
export const STORY_PIXEL_HEIGHT = 1920;

/**
 * React Native view layout uses logical points and is rasterized at the device
 * pixel ratio. This gives the hidden capture view a 1080×1920 native backing
 * surface. captureRef intentionally receives no width/height override because
 * view-shot 4.0.3 applies those options differently on Android and iOS.
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
