// Auth primitives. Preserves the original token contract exactly — HS256, with
// issuer vollo and audience vollo-app, subject = user id, 30-day expiry — so
// the mobile client's bearer-token flow is unchanged. `jose` is used instead of
// `jsonwebtoken` because it's first-class in the Deno edge runtime; `bcryptjs`
// (pure JS) ports unchanged for password hashing.
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { config } from './config.ts';
import { getSecret } from './db.ts';
import type { AuthClaims } from './types.ts';

const JWT_ISSUER = 'vollo';
const JWT_AUDIENCE = 'vollo-app';

let keyCache: Uint8Array | null = null;
async function signingKey(): Promise<Uint8Array> {
  if (!keyCache) keyCache = new TextEncoder().encode(await getSecret('jwt_secret'));
  return keyCache;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.auth.bcryptRounds);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function signToken(claims: AuthClaims): Promise<string> {
  return await new SignJWT({ username: claims.username })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(config.auth.jwtExpiresIn)
    .sign(await signingKey());
}

export async function verifyToken(token: string): Promise<AuthClaims> {
  const { payload } = await jwtVerify(token, await signingKey(), {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: ['HS256'],
  });
  return { sub: payload.sub as string, username: payload.username as string };
}
