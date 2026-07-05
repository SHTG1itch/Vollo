// Pick an image from the library, crop it, and upload it to the signed-in user's
// OWN folder in the public `user-media` Storage bucket — returning a public,
// cache-busted URL ready to persist (avatar_url / cover_url / match photo_url).
//
// The upload uses the device's own Supabase session (the `authenticated` role),
// so Storage RLS confines every write to "<auth_uid>/…" (see migration 018). The
// edge function stays the only writer of the DB columns; it just receives the URL.
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from './supabase';

const BUCKET = 'user-media';

/** Reject absurdly large picks up front — the bucket/CDN shouldn't be fed
 *  multi-hundred-MB originals, and mobile uploads of them mostly time out. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/** supabase-js storage has no abort hook, so cap the wall-clock time ourselves —
 *  the underlying request keeps going, but the UI gets a clear error instead of
 *  spinning forever on a dead connection. */
const UPLOAD_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

/** Profile media lives at a stable key so re-uploads overwrite (no orphan files). */
export type ProfileMediaKind = 'avatar' | 'cover';

async function currentAuthUid(): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error('You must be signed in to upload a photo.');
  // The Storage folder is the AUTH uid (session.user.id = users.auth_id), which is
  // what auth.uid() returns in the RLS policy — NOT the app users.id.
  return session.user.id;
}

/**
 * Upload the picked asset's bytes to `path` and return its public URL.
 *
 * The byte read is the load-bearing RN detail: `new File(uri).bytes()` does a
 * native read into a Uint8Array. We deliberately do NOT use
 * `fetch(uri).then(r => r.blob())` — in React Native a Blob is a lazy native
 * file handle and on Android/Hermes the body often serialises to 0 bytes, which
 * would silently store an empty object. supabase-js sends the Uint8Array as the
 * raw request body with our explicit contentType.
 */
async function uploadAsset(
  path: string,
  asset: ImagePicker.ImagePickerAsset,
  { upsert }: { upsert: boolean },
): Promise<string> {
  const bytes = await new File(asset.uri).bytes();
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error('That photo is too large — please pick an image under 10 MB.');
  }
  const { error } = await withTimeout(
    supabase.storage.from(BUCKET).upload(path, bytes, {
      contentType: asset.mimeType ?? 'image/jpeg', // RN can't infer; without it you get octet-stream
      upsert,
      cacheControl: '3600',
    }),
    UPLOAD_TIMEOUT_MS,
    'The upload took too long. Check your connection and try again.',
  );
  if (error) throw error;
  const {
    data: { publicUrl },
  } = supabase.storage.from(BUCKET).getPublicUrl(path);
  // Stable keys (avatar/cover) would otherwise serve stale CDN/<Image>-cache
  // bytes after a re-upload; the ?v= query changes the URL so both refetch.
  return `${publicUrl}?v=${Date.now()}`;
}

async function pickImage(
  options: ImagePicker.ImagePickerOptions,
): Promise<ImagePicker.ImagePickerAsset | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('Photo access is needed to pick an image. Enable it in Settings.');
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.85,
    ...options,
  });
  if (result.canceled || !result.assets[0]) return null;
  return result.assets[0];
}

/**
 * Pick + crop a profile photo (square avatar) or cover banner (16:9) and upload
 * it. Returns the public URL to persist via api.updateProfile, or null if the
 * user cancelled.
 */
export async function pickAndUploadProfileImage(kind: ProfileMediaKind): Promise<string | null> {
  const asset = await pickImage({
    allowsEditing: true,
    aspect: kind === 'cover' ? [16, 9] : [1, 1],
  });
  if (!asset) return null;
  const authUid = await currentAuthUid();
  return uploadAsset(`${authUid}/${kind}.jpg`, asset, { upsert: true });
}

/**
 * Pick + crop a photo to attach to a match and upload it. A match can have many
 * photos over time, so the key is unique (timestamped) rather than stable.
 * Returns the public URL to send with the match payload, or null if cancelled.
 */
export async function pickAndUploadMatchPhoto(): Promise<string | null> {
  const asset = await pickImage({ allowsEditing: true, aspect: [4, 3] });
  if (!asset) return null;
  const authUid = await currentAuthUid();
  return uploadAsset(`${authUid}/match/${Date.now()}.jpg`, asset, { upsert: false });
}
