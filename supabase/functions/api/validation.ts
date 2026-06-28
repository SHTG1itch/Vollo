import { z } from 'zod';

export const surfaceSchema = z.enum(['hard', 'clay', 'grass', 'indoor']);

// Server-side sign-in proxy: the client posts a username (or email) + password and
// we resolve the email internally, so the email never travels back to the client.
// Kept lenient on the identifier (could be either) and matched to Supabase Auth's
// 72-char password ceiling.
export const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(72),
});

const setSchema = z.tuple([z.number().int().min(0).max(99), z.number().int().min(0).max(99)]);
export const scoreArraySchema = z.array(setSchema).min(1).max(5);

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

// Allow a little clock skew between the client and server, but reject matches
// dated meaningfully in the future — they would pin to the top of the feed
// forever and poison the trailing-window court leaderboard.
const PLAYED_AT_SKEW_MS = 5 * 60_000;

export const createMatchSchema = z
  .object({
    opponent_id: z.string().uuid().optional(),
    opponent_name: z.string().trim().max(60).optional(),
    court_id: z.string().uuid().optional(),
    // When this match fulfils a scheduled proposal, link it so the result shows
    // on both players' scheduled-match cards.
    scheduled_match_id: z.string().uuid().optional(),
    surface: surfaceSchema,
    score_array: scoreArraySchema,
    // Optional short headline for the match, shown on the feed card.
    title: z.string().trim().max(80).optional(),
    // A single proof-of-play photo (the scoreboard, the court). Public URL the
    // client uploaded to Storage; the edge function only persists the string.
    photo_url: z.string().trim().url().max(500).optional(),
    rpe_index: z.number().int().min(1).max(10).optional(),
    duration_minutes: z.number().int().min(1).max(600).optional(),
    notes: z.string().trim().max(500).optional(),
    is_tiebreak: z.boolean().optional(),
    played_at: z
      .string()
      .datetime()
      .refine((v) => new Date(v).getTime() <= Date.now() + PLAYED_AT_SKEW_MS, {
        message: 'played_at cannot be in the future',
      })
      .optional(),
    stats: matchStatsSchema.partial().optional(),
  })
  // Tagging a registered opponent (opponent_id) and a free-text name are mutually
  // exclusive — accepting both silently dropped the name. Make it an explicit 400.
  .refine((b) => !(b.opponent_id && b.opponent_name), {
    message: 'Provide either opponent_id or opponent_name, not both',
    path: ['opponent_name'],
  })
  // Reject internally-impossible stat lines (a subset can't exceed its total)
  // rather than storing numbers that skew analytics.
  .superRefine((b, ctx) => {
    const s = b.stats;
    if (!s) return;
    const pairs: [keyof typeof s, keyof typeof s][] = [
      ['first_serve_in', 'first_serve_total'],
      ['second_serve_in', 'second_serve_total'],
      ['break_points_won', 'break_points_total'],
    ];
    for (const [part, total] of pairs) {
      const a = s[part];
      const t = s[total];
      if (a != null && t != null && a > t) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${String(part)} cannot exceed ${String(total)}`, path: ['stats', part] });
      }
    }
  });

// ─── Scheduled matches ──────────────────────────────────────────────────────
const SCHEDULE_MAX_AHEAD_MS = 365 * 86_400_000; // a year out is plenty

export const createScheduledMatchSchema = z
  .object({
    opponent_id: z.string().uuid().optional(),
    opponent_name: z.string().trim().max(60).optional(),
    court_id: z.string().uuid().optional(),
    surface: surfaceSchema.optional(),
    scheduled_at: z
      .string()
      .datetime()
      .refine((v) => new Date(v).getTime() >= Date.now() - PLAYED_AT_SKEW_MS, {
        message: 'scheduled_at cannot be in the past',
      })
      .refine((v) => new Date(v).getTime() <= Date.now() + SCHEDULE_MAX_AHEAD_MS, {
        message: 'scheduled_at is too far in the future',
      }),
    note: z.string().trim().max(280).optional(),
    // A challenge is just a scheduled match with combative framing (changes the
    // notification + card label); only meaningful when challenging a Vollo player.
    is_challenge: z.boolean().optional(),
  })
  .refine((b) => b.opponent_id || b.opponent_name, {
    message: 'Provide an opponent (a Vollo player or a name)',
    path: ['opponent_name'],
  })
  .refine((b) => !(b.opponent_id && b.opponent_name), {
    message: 'Provide either opponent_id or opponent_name, not both',
    path: ['opponent_name'],
  });

export const updateScheduledMatchSchema = z.object({
  action: z.enum(['accept', 'decline', 'cancel']),
});

// The tagged opponent confirms (it counts) or rejects (it never counts) a match.
export const verifyMatchSchema = z.object({
  action: z.enum(['confirm', 'reject']),
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
  // How many physical courts the facility holds — a user adding a multi-court
  // venue can mark it as one sector (defaults to 1).
  court_count: z.number().int().min(1).max(60).optional(),
});

// Public gear loadout. A blank string in any field is normalised to "unset" so
// clients can clear a field by sending '' without persisting an empty string.
const gearField = z
  .string()
  .trim()
  .max(80)
  .transform((v) => (v.length ? v : undefined))
  .optional();

export const equipmentSchema = z
  .object({
    racquet: gearField,
    strings: gearField,
    string_tension: z.string().trim().max(40).transform((v) => (v.length ? v : undefined)).optional(),
    shoes: gearField,
  })
  .strict();

export const updateProfileSchema = z.object({
  display_name: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().max(280).optional(),
  avatar_url: z.string().trim().url().max(500).optional(),
  cover_url: z.string().trim().url().max(500).optional(),
  dominant_hand: z.enum(['right', 'left']).optional(),
  // Signature colour as #RRGGBB. Empty string clears it back to "unset" so the
  // client can reset to the default hashed hue.
  color: z
    .string()
    .trim()
    .transform((v) => (v.length ? v : null))
    .refine((v) => v === null || /^#[0-9A-Fa-f]{6}$/.test(v), { message: 'color must be a #RRGGBB hex string' })
    .nullable()
    .optional(),
  home: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      label: z.string().trim().max(160).optional(),
    })
    .optional(),
  equipment: equipmentSchema.optional(),
});

// A query-string boolean: "1"/"true" → true, anything else present → false,
// absent or empty → the default. Tolerant so a stray/empty flag never 400s.
const boolParam = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : v === '1' || v === 'true'));

// Discovery imports real-world courts within a map viewport. Reuses the bbox
// shape but requires all four corners (a viewport is never partial).
//   import=0 → return DB courts only (instant first paint, no Overpass call)
//   force=1  → bypass the per-viewport import cache (used by the backfill)
export const discoverQuerySchema = z.object({
  min_lng: z.coerce.number().min(-180).max(180),
  min_lat: z.coerce.number().min(-90).max(90),
  max_lng: z.coerce.number().min(-180).max(180),
  max_lat: z.coerce.number().min(-90).max(90),
  import: boolParam(true),
  force: boolParam(false),
});

export const reverseGeocodeQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
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

export const bboxQuerySchema = z
  .object({
    min_lng: z.coerce.number().min(-180).max(180).optional(),
    min_lat: z.coerce.number().min(-90).max(90).optional(),
    max_lng: z.coerce.number().min(-180).max(180).optional(),
    max_lat: z.coerce.number().min(-90).max(90).optional(),
  })
  // A bounding box is all-or-nothing, and each axis must be min < max. A partial
  // or inverted envelope is a client bug — reject it instead of silently falling
  // back to an unbounded global listing.
  .superRefine((v, ctx) => {
    const present = [v.min_lng, v.min_lat, v.max_lng, v.max_lat].filter((x) => x != null).length;
    if (present > 0 && present < 4) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox requires all of min_lng, min_lat, max_lng, max_lat' });
      return;
    }
    if (present === 4) {
      if (v.min_lng! >= v.max_lng!) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'min_lng must be < max_lng', path: ['min_lng'] });
      if (v.min_lat! >= v.max_lat!) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'min_lat must be < max_lat', path: ['min_lat'] });
    }
  });

export const geocodeQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export const userSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(60),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const commentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().datetime().optional(),
});

export type CreateMatchInput = z.infer<typeof createMatchSchema>;
export type CreateCourtInput = z.infer<typeof createCourtSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
