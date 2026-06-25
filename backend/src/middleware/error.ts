import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ApiError } from '../utils/errors.js';

/** 404 fallback for unmatched routes. */
export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound('Route not found'));
}

/** Central error serialiser. Translates ApiError / ZodError / unknown errors. */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Request validation failed',
        details: err.flatten(),
      },
    });
    return;
  }

  // Postgres unique-violation → 409
  if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23505') {
    res.status(409).json({
      error: { code: 'conflict', message: 'Resource already exists' },
    });
    return;
  }

  console.error('[error] unhandled', err);
  res.status(500).json({
    error: { code: 'internal_error', message: 'Something went wrong' },
  });
}
