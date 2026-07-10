export type PasswordRecoveryLink =
  | { kind: 'tokens'; accessToken: string; refreshToken: string }
  | { kind: 'code'; code: string }
  | { kind: 'invalid' };

const MAX_CREDENTIAL_LENGTH = 8192;

function bounded(value: string | null): string | null {
  if (!value || value.length > MAX_CREDENTIAL_LENGTH) return null;
  return value;
}

/** Parse Supabase's implicit-token and PKCE recovery callbacks without ever
 * forwarding their credentials to React Navigation or keeping them in a route.
 * `invalid` means it was a reset callback but lacked a complete credential and
 * must still be consumed rather than parked as an ordinary deep link. */
export function parsePasswordRecoveryLink(url: string): PasswordRecoveryLink | null {
  if (!url || url.length > 24_000) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'vollo:') return null;

    const destination = `${parsed.hostname}${parsed.pathname}`
      .replace(/^\/+|\/+$/g, '')
      .toLowerCase();
    const fragment = new URLSearchParams(parsed.hash.replace(/^#/, ''));
    const isRecoveryDestination = destination === 'reset-password';
    if (!isRecoveryDestination) return null;

    const code = bounded(parsed.searchParams.get('code') ?? fragment.get('code'));
    if (code) return { kind: 'code', code };

    const accessToken = bounded(
      parsed.searchParams.get('access_token') ?? fragment.get('access_token'),
    );
    const refreshToken = bounded(
      parsed.searchParams.get('refresh_token') ?? fragment.get('refresh_token'),
    );
    if (accessToken && refreshToken) return { kind: 'tokens', accessToken, refreshToken };
    return { kind: 'invalid' };
  } catch {
    return null;
  }
}
