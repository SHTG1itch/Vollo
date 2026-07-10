// Pick an image from the library, crop it, and upload it to the signed-in user's
// OWN folder in the public `user-media` Storage bucket — returning a public,
// cache-busted URL ready to persist (avatar_url / cover_url / match photo_url).
//
// The upload uses the device's own Supabase session (the `authenticated` role),
// so Storage RLS confines every write to "<auth_uid>/…" (see migration 018). The
// edge function stays the only writer of the DB columns; it just receives the URL.
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { api } from '../api/client';
import { supabase } from './supabase';

const BUCKET = 'user-media';

/** Reject absurdly large picks up front — the bucket/CDN shouldn't be fed
 *  multi-hundred-MB originals, and mobile uploads of them mostly time out. */
// Must match storage.buckets.file_size_limit (migration 018). Keeping the client
// ceiling identical avoids accepting an 8–10 MB file only for Storage to reject
// it later with a much less useful error.
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB

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

export type ProfileMediaKind = 'avatar' | 'cover';
export type UploadedProfileImage = { url: string; path: string; ownerId: string };
export type MatchPhotoDraft = { asset: ImagePicker.ImagePickerAsset; ownerId: string };
export type UploadedMatchPhoto = { url: string; path: string; ownerId: string };

export async function getProfileMediaOwnerId(): Promise<string> {
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
  // ImagePicker reports the original size on supported platforms. Check it
  // before materializing the whole file as a Uint8Array to avoid an avoidable
  // out-of-memory crash on a very large camera-roll item.
  if (asset.fileSize != null && asset.fileSize > MAX_UPLOAD_BYTES) {
    throw new Error('That photo is too large — please pick an image under 8 MB.');
  }
  const bytes = await new File(asset.uri).bytes();
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error('That photo is too large — please pick an image under 8 MB.');
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

/** Pick and crop profile media without uploading it. Keeping the selected file
 * local until the user taps Save prevents a cancelled edit from changing the
 * persisted profile or leaving an unwanted upload behind. */
export async function pickProfileImage(kind: ProfileMediaKind): Promise<ImagePicker.ImagePickerAsset | null> {
  return pickImage({
    allowsEditing: true,
    aspect: kind === 'cover' ? [16, 9] : [1, 1],
  });
}

/** Upload a profile draft after the user has committed the form. */
export async function uploadProfileImage(
  kind: ProfileMediaKind,
  asset: ImagePicker.ImagePickerAsset,
  expectedOwnerId: string,
): Promise<UploadedProfileImage> {
  const authUid = await getProfileMediaOwnerId();
  if (authUid !== expectedOwnerId) {
    throw new Error('Your sign-in changed while saving. Review the profile and try again.');
  }
  // Versioned objects keep a failed database PATCH from changing the bytes
  // behind the old persisted URL. The caller removes this staged object if the
  // PATCH fails and removes the previous object only after the PATCH succeeds.
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const path = `${authUid}/profile/${kind}-${nonce}.jpg`;
  // Register the exact path before Storage receives any bytes. If the upload or
  // subsequent profile PATCH becomes ambiguous (app kill, timeout, lost reply),
  // the backend can still remove an unreferenced object after the draft lease.
  await api.registerProfilePhotoDraft(path);
  const url = await uploadAsset(path, asset, { upsert: false });
  return { url, path, ownerId: authUid };
}

export async function removeProfileImageObject(path: string, expectedOwnerId: string): Promise<void> {
  const authUid = await getProfileMediaOwnerId();
  if (authUid !== expectedOwnerId || !path.startsWith(`${authUid}/`)) return;
  const { error } = await withTimeout(
    supabase.storage.from(BUCKET).remove([path]),
    UPLOAD_TIMEOUT_MS,
    'Photo removal took too long. Check your connection and try again.',
  );
  if (error) throw error;
}

/** Remove a staged profile object and only then dismiss its durable cleanup
 * lease. If Storage removal fails, retaining the lease is the safe outcome. */
export async function discardProfileImageDraft(uploaded: UploadedProfileImage): Promise<void> {
  await removeProfileImageObject(uploaded.path, uploaded.ownerId);
  await api.discardProfilePhotoDraft(uploaded.path);
}

function ownedProfilePathFromPublicUrl(
  url: string,
  ownerId: string,
  kind: ProfileMediaKind,
): string | null {
  try {
    const parsed = new URL(url);
    const marker = `/storage/v1/object/public/${BUCKET}/`;
    if (!parsed.pathname.startsWith(marker)) return null;
    const path = decodeURIComponent(parsed.pathname.slice(marker.length));
    const segments = path.split('/');
    if (segments[0] !== ownerId) return null;
    const versioned = segments.length >= 3
      && segments[1] === 'profile'
      && segments[2]!.startsWith(`${kind}-`);
    const legacy = segments.length === 2 && segments[1] === `${kind}.jpg`;
    return versioned || legacy ? path : null;
  } catch {
    return null;
  }
}

/** Delete an old Vollo-owned profile object after its database reference was
 * replaced or cleared. OAuth avatars and malformed/cross-owner URLs are ignored. */
export async function removeProfileImageUrl(
  url: string | null | undefined,
  ownerId: string,
  kind: ProfileMediaKind,
): Promise<void> {
  if (!url) return;
  const path = ownedProfilePathFromPublicUrl(url, ownerId, kind);
  if (path) await removeProfileImageObject(path, ownerId);
}

/** Pick a match photo but keep it on-device until the form is submitted. */
export async function pickMatchPhotoDraft(): Promise<MatchPhotoDraft | null> {
  const asset = await pickImage({ allowsEditing: true, aspect: [4, 3] });
  if (!asset) return null;
  return { asset, ownerId: await getProfileMediaOwnerId() };
}

/** Stage a selected match photo under the create request's idempotency key.
 * A network-ambiguous retry therefore reuses both the DB row and its image. */
export async function uploadMatchPhoto(
  draft: MatchPhotoDraft,
  clientKey: string,
): Promise<UploadedMatchPhoto> {
  const path = matchPhotoObjectPath(draft, clientKey);
  const authUid = await getProfileMediaOwnerId();
  if (authUid !== draft.ownerId) {
    throw new Error('Your sign-in changed while saving. Review the match and try again.');
  }
  // Upsert makes a retry safe if the prior upload timed out locally after
  // Storage had already accepted the bytes.
  const url = await uploadAsset(path, draft.asset, { upsert: true });
  return { url, path, ownerId: authUid };
}

export function matchPhotoObjectPath(draft: MatchPhotoDraft, clientKey: string): string {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(clientKey)) {
    throw new Error('Could not prepare a safe match photo key. Please try again.');
  }
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(draft.ownerId)) {
    throw new Error('Could not verify the match photo owner. Please sign in again.');
  }
  return `${draft.ownerId}/match/${clientKey}.jpg`;
}

export async function removeMatchPhotoObject(uploaded: UploadedMatchPhoto): Promise<void> {
  await removeProfileImageObject(uploaded.path, uploaded.ownerId);
}
