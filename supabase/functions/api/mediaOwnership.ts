const PUBLIC_MEDIA_MARKER = '/storage/v1/object/public/user-media/';
export type UserMediaKind = 'avatar' | 'cover' | 'match';

function isOwnedUserMediaPath(
  decodedPath: string,
  authId: string,
  expectedKind?: UserMediaKind,
): boolean {
  const segments = decodedPath.split('/');
  if (segments.length < 2 || segments[0] !== authId) return false;
  if (!segments.every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..' && !segment.includes('\\'),
  )) return false;
  if (!expectedKind) return true;
  if (expectedKind === 'match') return segments.length >= 3 && segments[1] === 'match';

  // New profile uploads are versioned under profile/avatar-* and
  // profile/cover-*. Keep the original root avatar.jpg/cover.jpg shape valid
  // so an existing user can edit an unrelated field without migration pain.
  const prefix = `${expectedKind}-`;
  return (segments.length >= 3 && segments[1] === 'profile' && segments[2]!.startsWith(prefix))
    || (segments.length === 2 && segments[1] === `${expectedKind}.jpg`);
}

export function ownedUserMediaPathFromUrl(
  value: string,
  authId: string,
  expectedKind?: UserMediaKind,
): string | null {
  try {
    const url = new URL(value);
    if (!url.pathname.startsWith(PUBLIC_MEDIA_MARKER)) return null;
    const decodedPath = decodeURIComponent(url.pathname.slice(PUBLIC_MEDIA_MARKER.length));
    return isOwnedUserMediaPath(decodedPath, authId, expectedKind) ? decodedPath : null;
  } catch {
    return null;
  }
}

/** True only when a public Vollo Storage URL points inside this auth user's
 * top-level folder. Origin allowlisting is handled by validation.ts before this
 * ownership check runs. */
export function isOwnedUserMediaUrl(
  value: string,
  authId: string,
  expectedKind?: UserMediaKind,
): boolean {
  return ownedUserMediaPathFromUrl(value, authId, expectedKind) !== null;
}

export function isGoogleAvatarUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com'));
  } catch {
    return false;
  }
}
