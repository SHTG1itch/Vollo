// Small, dependency-free helpers for the native auth-storage protocol. Keeping
// the framing logic separate makes it possible to stress-test large sessions
// without loading React Native or a native SecureStore module in Node.
export const SESSION_CHUNK_SIZE = 1_800;
export const SESSION_MAX_CHUNKS = 32;
export const SESSION_MANIFEST_PREFIX = 'VOLLO_SESSION_V1:';

export type SessionSlot = 'a' | 'b';

export interface SessionManifest {
  slot: SessionSlot;
  chunks: number;
}

export function splitSessionValue(value: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += SESSION_CHUNK_SIZE) {
    chunks.push(value.slice(offset, offset + SESSION_CHUNK_SIZE));
  }
  // SecureStore accepts an empty string, but still represent it explicitly so
  // a committed manifest can never point at zero chunks.
  if (chunks.length === 0) chunks.push('');
  if (chunks.length > SESSION_MAX_CHUNKS) {
    throw new Error('The authentication session is too large to store safely on this device.');
  }
  return chunks;
}

export function encodeSessionManifest(manifest: SessionManifest): string {
  return `${SESSION_MANIFEST_PREFIX}${manifest.slot}:${manifest.chunks}`;
}

export function decodeSessionManifest(value: string | null): SessionManifest | null {
  if (!value?.startsWith(SESSION_MANIFEST_PREFIX)) return null;
  const match = /^([ab]):([1-9]|[12][0-9]|3[0-2])$/.exec(value.slice(SESSION_MANIFEST_PREFIX.length));
  if (!match) return null;
  return { slot: match[1] as SessionSlot, chunks: Number(match[2]) };
}

export function sessionChunkKey(key: string, slot: SessionSlot, index: number): string {
  return `${key}.vollo.${slot}.${index}`;
}

export function sessionSlotCountKey(key: string, slot: SessionSlot): string {
  return `${key}.vollo.${slot}.count`;
}
