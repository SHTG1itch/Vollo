import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import {
  SESSION_MANIFEST_PREFIX,
  SESSION_MAX_CHUNKS,
  decodeSessionManifest,
  encodeSessionManifest,
  sessionChunkKey,
  sessionSlotCountKey,
  splitSessionValue,
  type SessionSlot,
} from '../utils/sessionChunks';

type SecureStoreModule = typeof import('expo-secure-store');

// Keep SecureStore out of the web runtime. It has no web implementation, while
// AsyncStorage maps to browser storage and preserves the existing web behavior.
function loadSecureStore(): SecureStoreModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-secure-store') as SecureStoreModule;
}

const slots: SessionSlot[] = ['a', 'b'];
let nativeOperation: Promise<void> = Promise.resolve();

function serializeNative<T>(operation: () => Promise<T>): Promise<T> {
  const result = nativeOperation.then(operation, operation);
  nativeOperation = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function secureOptions(SecureStore: SecureStoreModule) {
  return { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
}

function parseStoredCount(value: string | null): number | null {
  if (!value || !/^([1-9]|[12][0-9]|3[0-2])$/.test(value)) return null;
  return Number(value);
}

async function clearSlot(
  SecureStore: SecureStoreModule,
  key: string,
  slot: SessionSlot,
  fallbackCount = 0,
  clearDefensively = false,
): Promise<void> {
  const countKey = sessionSlotCountKey(key, slot);
  const storedCount = await SecureStore.getItemAsync(countKey);
  const parsedCount = parseStoredCount(storedCount);
  const count = parsedCount
    ?? (clearDefensively && storedCount != null ? SESSION_MAX_CHUNKS : fallbackCount);
  for (let index = 0; index < count; index += 1) {
    await SecureStore.deleteItemAsync(sessionChunkKey(key, slot, index));
  }
  await SecureStore.deleteItemAsync(countKey);
}

async function clearNativeValue(SecureStore: SecureStoreModule, key: string): Promise<void> {
  const raw = await SecureStore.getItemAsync(key);
  const manifest = decodeSessionManifest(raw);
  const corruptManifest = raw?.startsWith(SESSION_MANIFEST_PREFIX) === true && manifest == null;
  // Both slots are cleared because a process can be killed after its inactive
  // slot is written but before the final manifest swap.
  let firstError: unknown;
  for (const slot of slots) {
    const fallback = corruptManifest
      ? SESSION_MAX_CHUNKS
      : manifest?.slot === slot
        ? manifest.chunks
        : 0;
    try {
      await clearSlot(SecureStore, key, slot, fallback, true);
    } catch (error) {
      firstError ??= error;
    }
  }
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (error) {
    firstError ??= error;
  }
  if (firstError) throw firstError;
}

async function writeNativeValue(
  SecureStore: SecureStoreModule,
  key: string,
  value: string,
): Promise<void> {
  const currentRaw = await SecureStore.getItemAsync(key);
  const current = decodeSessionManifest(currentRaw);
  const target: SessionSlot = current?.slot === 'a' ? 'b' : 'a';
  const chunks = splitSessionValue(value);
  const options = secureOptions(SecureStore);

  // The count is committed before the chunks. If the OS terminates the process
  // mid-write, the next mutation can still find and erase every partial chunk.
  await clearSlot(SecureStore, key, target, 0, true);
  await SecureStore.setItemAsync(sessionSlotCountKey(key, target), String(chunks.length), options);
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      await SecureStore.setItemAsync(sessionChunkKey(key, target, index), chunks[index], options);
    }
    // The small manifest is the atomic commit point: readers see either the
    // complete previous value or the complete new value, never half a session.
    await SecureStore.setItemAsync(
      key,
      encodeSessionManifest({ slot: target, chunks: chunks.length }),
      options,
    );
  } catch (error) {
    await clearSlot(SecureStore, key, target, chunks.length, true).catch(() => {});
    throw error;
  }

  // The new value is already committed. Keep the old slot's count metadata if
  // cleanup fails so a later write/removal can retry without making login fail.
  if (current) await clearSlot(SecureStore, key, current.slot, current.chunks, true).catch(() => {});
}

async function readNativeValue(SecureStore: SecureStoreModule, key: string): Promise<string | null> {
  const raw = await SecureStore.getItemAsync(key);
  const manifest = decodeSessionManifest(raw);
  if (manifest) {
    const values: string[] = [];
    for (let index = 0; index < manifest.chunks; index += 1) {
      const chunk = await SecureStore.getItemAsync(sessionChunkKey(key, manifest.slot, index));
      if (chunk == null) {
        // Corrupt or externally-cleared Keychain data cannot safely form a
        // refresh token. Fail closed and remove all fragments.
        await clearNativeValue(SecureStore, key).catch(() => {});
        return null;
      }
      values.push(chunk);
    }
    return values.join('');
  }

  if (raw != null) {
    if (raw.startsWith(SESSION_MANIFEST_PREFIX)) {
      await clearNativeValue(SecureStore, key).catch(() => {});
      return null;
    }
    // Compatibility with the direct SecureStore adapter used by older builds.
    return raw;
  }

  // One-time migration from the original plaintext AsyncStorage adapter. Only
  // remove the old copy after the complete secure value is committed.
  const legacy = await AsyncStorage.getItem(key);
  if (legacy != null) {
    await writeNativeValue(SecureStore, key, legacy);
    await AsyncStorage.removeItem(key);
  }
  return legacy;
}

const secureNativeStorage = {
  getItem(key: string): Promise<string | null> {
    return serializeNative(() => readNativeValue(loadSecureStore(), key));
  },
  setItem(key: string, value: string): Promise<void> {
    return serializeNative(async () => {
      await writeNativeValue(loadSecureStore(), key, value);
      await AsyncStorage.removeItem(key).catch(() => {});
    });
  },
  removeItem(key: string): Promise<void> {
    return serializeNative(async () => {
      let nativeError: unknown;
      try {
        await clearNativeValue(loadSecureStore(), key);
      } catch (error) {
        nativeError = error;
      }
      await AsyncStorage.removeItem(key);
      if (nativeError) throw nativeError;
    });
  },
};

export const authStorage = Platform.OS === 'web' ? AsyncStorage : secureNativeStorage;
