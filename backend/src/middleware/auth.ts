import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../utils/auth.js';
import { ApiError } from '../utils/errors.js';
import type { AuthClaims } from '../types/index.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthClaims;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  // Parse case-insensitively and tolerate extra whitespace, e.g. "bearer  <tok>".
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

/** Reject the request unless a valid bearer token is present. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) return next(ApiError.unauthorized());
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    next(ApiError.unauthorized('Invalid or expired token'));
  }
}

/** Attach the user if a valid token is present, but never reject. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (token) {
    try {
      req.user = verifyToken(token);
    } catch {
      /* ignore — treated as anonymous */
    }
  }
  next();
}

/** Convenience: the authenticated user's id, asserting it exists. */
export function userId(req: Request): string {
  if (!req.user) throw ApiError.unauthorized();
  return req.user.sub;
}
