// Helpers that convert raw Postgres rows into the API DTOs declared in types.ts.
// NUMERIC columns arrive as strings from the driver; we coerce the specific
// fields the client expects to be numbers.
import type { Court, Equipment, Match, MatchCard, ScheduledMatchCard, ScoreArray, User } from './types.ts';

/**
 * timestamptz columns arrive as JS `Date` objects. `String(date)` yields a
 * locale string — not ISO — which breaks both clients and the feed cursor
 * contract. Always serialize timestamps as ISO 8601.
 */
export function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  }
  return String(v);
}

export function mapUser(r: Record<string, unknown>): User {
  return {
    id: r.id as string,
    username: r.username as string,
    email: r.email as string,
    display_name: r.display_name as string,
    avatar_url: (r.avatar_url as string | null) ?? null,
    cover_url: (r.cover_url as string | null) ?? null,
    bio: (r.bio as string | null) ?? null,
    dominant_hand: (r.dominant_hand as 'right' | 'left') ?? 'right',
    color: (r.color as string | null) ?? null,
    home_lat: r.home_lat != null ? Number(r.home_lat) : null,
    home_lng: r.home_lng != null ? Number(r.home_lng) : null,
    home_label: (r.home_label as string | null) ?? null,
    equipment: normalizeEquipment(r.equipment),
    is_private: Boolean(r.is_private),
    // Default true: the column ships with DEFAULT true and older SELECTs that
    // omit it must not read as "hidden".
    show_competitive: r.show_competitive == null ? true : Boolean(r.show_competitive),
    created_at: toIso(r.created_at),
  };
}

/** jsonb arrives parsed (object) from postgres.js; coerce to a clean Equipment. */
function normalizeEquipment(v: unknown): Equipment {
  if (!v || typeof v !== 'object') return {};
  const e = v as Record<string, unknown>;
  const out: Equipment = {};
  if (typeof e.racquet === 'string' && e.racquet) out.racquet = e.racquet;
  if (typeof e.strings === 'string' && e.strings) out.strings = e.strings;
  if (typeof e.string_tension === 'string' && e.string_tension) out.string_tension = e.string_tension;
  if (typeof e.shoes === 'string' && e.shoes) out.shoes = e.shoes;
  return out;
}

/**
 * Public view of a user. Email and the saved home location are account settings,
 * not profile data: a geocoder result can be a street address, and exact
 * coordinates must never leave the owner-only /auth/me response.
 *
 * Keep the three home fields as null instead of removing them so the mobile DTO
 * remains backward-compatible while older clients learn nothing sensitive.
 */
export function mapPublicUser(r: Record<string, unknown>): Omit<User, 'email'> {
  const {
    email: _email,
    home_lat: _homeLat,
    home_lng: _homeLng,
    home_label: _homeLabel,
    ...rest
  } = mapUser(r);
  void _email;
  void _homeLat;
  void _homeLng;
  void _homeLabel;
  return { ...rest, home_lat: null, home_lng: null, home_label: null };
}

export function mapCourt(r: Record<string, unknown>): Court {
  return {
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    surface: r.surface as Court['surface'],
    lat: Number(r.lat),
    lng: Number(r.lng),
    address: (r.address as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    osm_id: (r.osm_id as string | null) ?? null,
    source: (r.source as string | null) ?? 'user',
    sector_key: (r.sector_key as string | null) ?? null,
    court_count: r.court_count != null ? Number(r.court_count) : 1,
    created_at: toIso(r.created_at),
  };
}

function mapMatchBase(r: Record<string, unknown>): Match {
  return {
    id: r.id as string,
    user_id: r.user_id as string,
    opponent_id: (r.opponent_id as string | null) ?? null,
    opponent_name: (r.opponent_name as string | null) ?? null,
    court_id: (r.court_id as string | null) ?? null,
    surface: r.surface as Match['surface'],
    title: (r.title as string | null) ?? null,
    photo_url: (r.photo_url as string | null) ?? null,
    score_array: r.score_array as Match['score_array'],
    result: r.result as Match['result'],
    sets_won: Number(r.sets_won),
    sets_lost: Number(r.sets_lost),
    games_won: Number(r.games_won),
    games_lost: Number(r.games_lost),
    match_score: Number(r.match_score),
    streak_modifier: Number(r.streak_modifier),
    rpe_index: r.rpe_index != null ? Number(r.rpe_index) : null,
    duration_minutes: r.duration_minutes != null ? Number(r.duration_minutes) : null,
    notes: (r.notes as string | null) ?? null,
    is_tiebreak: Boolean(r.is_tiebreak),
    verification_status: (r.verification_status as Match['verification_status']) ?? 'auto',
    verified_at: r.verified_at != null ? toIso(r.verified_at) : null,
    played_at: toIso(r.played_at),
    created_at: toIso(r.created_at),
  };
}

export function mapMatch(r: Record<string, unknown>): Match {
  return mapMatchBase(r);
}

export function mapScheduledMatch(r: Record<string, unknown>, viewerId: string): ScheduledMatchCard {
  return {
    id: r.id as string,
    creator_id: r.creator_id as string,
    creator_username: r.creator_username as string,
    creator_display_name: r.creator_display_name as string,
    creator_avatar_url: (r.creator_avatar_url as string | null) ?? null,
    opponent_id: (r.opponent_id as string | null) ?? null,
    opponent_username: (r.opponent_username as string | null) ?? null,
    opponent_display_name: (r.opponent_display_name as string | null) ?? null,
    opponent_avatar_url: (r.opponent_avatar_url as string | null) ?? null,
    opponent_name: (r.opponent_name as string | null) ?? null,
    court_id: (r.court_id as string | null) ?? null,
    court_name: (r.court_name as string | null) ?? null,
    surface: (r.surface as ScheduledMatchCard['surface']) ?? null,
    scheduled_at: toIso(r.scheduled_at),
    note: (r.note as string | null) ?? null,
    status: r.status as ScheduledMatchCard['status'],
    is_challenge: Boolean(r.is_challenge),
    match_id: (r.match_id as string | null) ?? null,
    result_score: (r.result_score as ScoreArray | null) ?? null,
    result_logged_by: (r.result_logged_by as string | null) ?? null,
    viewer_role: (r.creator_id as string) === viewerId ? 'creator' : 'opponent',
    created_at: toIso(r.created_at),
  };
}

export function mapMatchCard(r: Record<string, unknown>): MatchCard {
  return {
    ...mapMatchBase(r),
    author_username: r.author_username as string,
    author_display_name: r.author_display_name as string,
    author_avatar_url: (r.author_avatar_url as string | null) ?? null,
    court_name: (r.court_name as string | null) ?? null,
    court_city: (r.court_city as string | null) ?? null,
    court_lat: r.court_lat != null ? Number(r.court_lat) : null,
    court_lng: r.court_lng != null ? Number(r.court_lng) : null,
    opponent_username: (r.opponent_username as string | null) ?? null,
    opponent_display_name: (r.opponent_display_name as string | null) ?? null,
    // API queries provide viewer-filtered aliases so a blocked actor's old
    // reaction is not exposed as an aggregate-count side channel. Fall back to
    // the view totals for internal callers that do not select the aliases.
    kudos_count: Number(r.visible_kudos_count ?? r.kudos_count ?? 0),
    comment_count: Number(r.visible_comment_count ?? r.comment_count ?? 0),
    viewer_has_kudos: r.viewer_has_kudos != null ? Boolean(r.viewer_has_kudos) : undefined,
  };
}
