import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { AuthClaims } from '../types/index.js';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.auth.bcryptRounds);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signToken(claims: AuthClaims): string {
  return jwt.sign(claims, config.auth.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: config.auth.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): AuthClaims {
  // Pin the algorithm so a forged token cannot downgrade/confuse verification.
  return jwt.verify(token, config.auth.jwtSecret, { algorithms: ['HS256'] }) as AuthClaims;
}
