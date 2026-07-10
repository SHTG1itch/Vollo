/** UUID v4 for retry-safe create operations. Modern Hermes supplies
 * crypto.randomUUID; the fallback remains collision-resistant enough for a
 * per-account idempotency key and preserves the UUID shape the API validates. */
export function newClientKey(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const random = (Math.random() * 16) | 0;
    return (ch === 'x' ? random : (random & 0x3) | 0x8).toString(16);
  });
}
