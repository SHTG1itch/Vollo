import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/errors.js';

/**
 * A tiny dependency-free, in-memory fixed-window rate limiter.
 *
 * Vollo runs as a single $0 web service, so a process-local counter is enough —
 * no Redis required. Each client (keyed by IP) gets `max` requests per
 * `windowMs`; exceeding it yields a 429 with a `Retry-After` header. A lazy
 * sweep evicts expired buckets so memory stays bounded.
 */
interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  message?: string;
}

export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, message } = opts;
  const buckets = new Map<string, Bucket>();
  let lastSweep = 0;

  return function rateLimiter(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();

    // Opportunistic eviction of expired buckets (at most once per window).
    if (now - lastSweep > windowMs) {
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
      }
      lastSweep = now;
    }

    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      next(ApiError.tooManyRequests(message));
      return;
    }

    next();
  };
}
