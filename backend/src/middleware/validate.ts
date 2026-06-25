import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny } from 'zod';

/**
 * Build a typed validator for the request body. Replaces req.body with the
 * parsed (and coerced) value so downstream handlers get clean, typed data.
 * Thrown ZodErrors are translated to 400s by the error middleware.
 */
export function validateBody<S extends ZodTypeAny>(schema: S) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.body = schema.parse(req.body);
    next();
  };
}

/**
 * Validate req.query. Express 5 makes req.query read-only, so the parsed value
 * is stashed under req.valid.query and read back with validatedQuery().
 */
export function validateQuery<S extends ZodTypeAny>(schema: S) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.parse(req.query);
    const r = req as Request & { valid?: Record<string, unknown> };
    r.valid = { ...r.valid, query: parsed };
    next();
  };
}

/** Read the validated query stashed by validateQuery. */
export function validatedQuery<T>(req: Request): T {
  return (req as Request & { valid?: { query?: T } }).valid?.query as T;
}
