// Helpers that convert raw Postgres rows into the API DTOs declared in
// ../types. NUMERIC columns arrive as strings from `pg`; we coerce the specific
// fields the client expects to be numbers.
import type { Court, Match, MatchCard, User } from '../types/index.js';

/**
 * `pg` returns timestamptz columns as JS `Date` objects. `String(date)` yields a
 * locale string like "Thu Jan 01 2024 ..." — not ISO — which breaks both clients
 * and the feed cursor contract. Always serialize timestamps as ISO 8601.
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
    bio: (r.bio as string | null) ?? null,
    dominant_hand: (r.dominant_hand as 'right' | 'left') ?? 'right',
    home_lat: r.home_lat != null ? Number(r.home_lat) : null,
    home_lng: r.home_lng != null ? Number(r.home_lng) : null,
    home_label: (r.home_label as string | null) ?? null,
    created_at: toIso(r.created_at),
  };
}

/**
 * Public view of a user — never exposes the private `email` (or any other
 * account-only field). Used for everyone except the authenticated account owner
 * so GET /users/:username can't be used to harvest email addresses.
 */
export function mapPublicUser(r: Record<string, unknown>): Omit<User, 'email'> {
  const { email: _email, ...rest } = mapUser(r);
  void _email;
  return rest;
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
    created_by: (r.created_by as string | null) ?? null,
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
    played_at: toIso(r.played_at),
    created_at: toIso(r.created_at),
  };
}

export function mapMatch(r: Record<string, unknown>): Match {
  return mapMatchBase(r);
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
    kudos_count: Number(r.kudos_count ?? 0),
    comment_count: Number(r.comment_count ?? 0),
    viewer_has_kudos: r.viewer_has_kudos != null ? Boolean(r.viewer_has_kudos) : undefined,
  };
}
