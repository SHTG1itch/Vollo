import { Router } from 'express';
import { validateQuery, validatedQuery } from '../middleware/validate.js';
import { asyncHandler } from '../utils/async-handler.js';
import { bboxQuerySchema } from '../validation/schemas.js';
import { getUserTerritories, listTerritories } from '../services/territory.js';
import type { z } from 'zod';

export const territoriesRouter = Router();

/**
 * All territory polygons as GeoJSON-ready features for the map overlay,
 * optionally clipped to the visible bounding box for performance.
 */
territoriesRouter.get(
  '/',
  validateQuery(bboxQuerySchema),
  asyncHandler(async (req, res) => {
    const b = validatedQuery<z.infer<typeof bboxQuerySchema>>(req);
    const hasBbox =
      b.min_lng != null && b.min_lat != null && b.max_lng != null && b.max_lat != null;
    const territories = await listTerritories(
      hasBbox
        ? { minLng: b.min_lng!, minLat: b.min_lat!, maxLng: b.max_lng!, maxLat: b.max_lat! }
        : undefined,
    );
    res.json({ territories });
  }),
);

territoriesRouter.get(
  '/user/:userId',
  asyncHandler(async (req, res) => {
    const territories = await getUserTerritories(req.params.userId);
    res.json({ territories });
  }),
);
