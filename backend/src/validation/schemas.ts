import { z } from 'zod';

export const surfaceSchema = z.enum(['hard', 'clay', 'grass', 'indoor']);

const setSchema = z.tuple([z.number().int().min(0).max(99), z.number().int().min(0).max(99)]);
export const scoreArraySchema = z.array(setSchema).min(1).max(5);

export const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_]+$/, 'username may only contain letters, numbers and underscores'),
  email: z.string().trim().email().max(254),
  // bcrypt only hashes the first 72 bytes; reject longer so two passwords that
  // share a 72-byte prefix can't silently collide.
  password: z
    .string()
    .min(8)
    .max(72)
    .refine((p) => new TextEncoder().encode(p).length <= 72, {
      message: 'password must be at most 72 bytes',
    }),
  display_name: z.string().trim().min(1).max(60),
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1), // username or email
  password: z.string().min(1),
});

// A single match can't realistically exceed a few hundred of any one event;
// cap each counter so bad input can't store absurd values that skew analytics.
const statCount = z.number().int().min(0).max(1000).default(0);

export const matchStatsSchema = z.object({
  first_serve_in: statCount,
  first_serve_total: statCount,
  second_serve_in: statCount,
  second_serve_total: statCount,
  aces: statCount,
  double_faults: statCount,
  forehand_winners: statCount,
  forehand_errors: statCount,
  backhand_winners: statCount,
  backhand_errors: statCount,
  volley_winners: statCount,
  volley_errors: statCount,
  rally_short: statCount,
  rally_medium: statCount,
  rally_long: statCount,
  break_points_won: statCount,
  break_points_total: statCount,
});

export const createMatchSchema = z.object({
  opponent_id: z.string().uuid().optional(),
  opponent_name: z.string().trim().max(60).optional(),
  court_id: z.string().uuid().optional(),
  surface: surfaceSchema,
  score_array: scoreArraySchema,
  rpe_index: z.number().int().min(1).max(10).optional(),
  duration_minutes: z.number().int().min(1).max(600).optional(),
  notes: z.string().trim().max(500).optional(),
  is_tiebreak: z.boolean().optional(),
  played_at: z.string().datetime().optional(),
  stats: matchStatsSchema.partial().optional(),
});

export const createCourtSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  surface: surfaceSchema.default('hard'),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().trim().max(240).optional(),
  city: z.string().trim().max(120).optional(),
  osm_id: z.string().trim().max(60).optional(),
});

export const updateProfileSchema = z.object({
  display_name: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().max(280).optional(),
  avatar_url: z.string().trim().url().max(500).optional(),
  dominant_hand: z.enum(['right', 'left']).optional(),
  home: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      label: z.string().trim().max(160).optional(),
    })
    .optional(),
});

export const commentSchema = z.object({
  body: z.string().trim().min(1).max(500),
});

export const pushTokenSchema = z.object({
  token: z.string().trim().min(1).max(300),
  platform: z.string().trim().max(20).optional(),
});

export const feedQuerySchema = z.object({
  scope: z.enum(['global', 'following']).default('global'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  // Opaque keyset cursor (encodes the last seen played_at + id); decoded server-side.
  before: z.string().max(200).optional(),
});

export const notificationIdsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

export const courtsQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  radius_km: z.coerce.number().min(0.1).max(200).default(25),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const bboxQuerySchema = z.object({
  min_lng: z.coerce.number().min(-180).max(180).optional(),
  min_lat: z.coerce.number().min(-90).max(90).optional(),
  max_lng: z.coerce.number().min(-180).max(180).optional(),
  max_lat: z.coerce.number().min(-90).max(90).optional(),
});

export const geocodeQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export type CreateMatchInput = z.infer<typeof createMatchSchema>;
export type CreateCourtInput = z.infer<typeof createCourtSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
