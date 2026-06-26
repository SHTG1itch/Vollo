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

  // Map common Postgres SQLSTATE codes to sensible client errors instead of 500s.
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const pgCode = (err as { code: string }).code;
    switch (pgCode) {
      case '23505': // unique_violation
        res.status(409).json({ error: { code: 'conflict', message: 'Resource already exists' } });
        return;
      case '22P02': // invalid_text_representation (e.g. a malformed UUID in the path)
      case '22003': // numeric_value_out_of_range
        res.status(400).json({ error: { code: 'bad_request', message: 'Invalid identifier or value' } });
        return;
      case '23503': // foreign_key_violation
        res.status(400).json({ error: { code: 'bad_request', message: 'Referenced resource does not exist' } });
        return;
      case '23514': // check_violation
        res.status(400).json({ error: { code: 'bad_request', message: 'Value failed a database constraint' } });
        return;
    }
  }

  console.error('[error] unhandled', err);
  res.status(500).json({
    error: { code: 'internal_error', message: 'Something went wrong' },
  });
}
