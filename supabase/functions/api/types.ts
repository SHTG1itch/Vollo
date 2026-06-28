// Shared domain types for the Vollo API. These mirror the database schema and
// the JSON shapes returned to the mobile client.

export type Surface = 'hard' | 'clay' | 'grass' | 'indoor';
export type MatchResult = 'win' | 'loss';
export type DominantHand = 'right' | 'left';

export type NotificationType =
  | 'kudos'
  | 'comment'
  | 'follow'
  | 'territory_gained'
  | 'territory_lost'
  | 'territory_changed'
  | 'court_taken'
  | 'court_dethroned'
  | 'match_tagged'
  | 'rank_up'
  | 'achievement'
  | 'streak_milestone';

/** A single set: [gamesForUser, gamesForOpponent], e.g. [6, 4]. */
export type SetScore = [number, number];
/** A full match score: list of sets, e.g. [[6,4],[2,6],[7,6]]. */
export type ScoreArray = SetScore[];

/** Public gear loadout shown on every profile. All fields optional. */
export interface Equipment {
  racquet?: string;
  strings?: string;
  string_tension?: string;
  shoes?: string;
}

export interface User {
  id: string;
  username: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  dominant_hand: DominantHand;
  home_lat: number | null;
  home_lng: number | null;
  home_label: string | null;
  equipment: Equipment;
  created_at: string;
}

export interface Court {
  id: string;
  name: string;
  description: string | null;
  surface: Surface;
  lat: number;
  lng: number;
  address: string | null;
  city: string | null;
  osm_id: string | null;
  /** 'user' for in-app additions, 'osm' for OpenStreetMap imports. */
  source: string;
  created_by: string | null;
  created_at: string;
}

export interface MatchStats {
  first_serve_in: number;
  first_serve_total: number;
  second_serve_in: number;
  second_serve_total: number;
  aces: number;
  double_faults: number;
  forehand_winners: number;
  forehand_errors: number;
  backhand_winners: number;
  backhand_errors: number;
  volley_winners: number;
  volley_errors: number;
  rally_short: number;
  rally_medium: number;
  rally_long: number;
  break_points_won: number;
  break_points_total: number;
}

export interface Match {
  id: string;
  user_id: string;
  opponent_id: string | null;
  opponent_name: string | null;
  court_id: string | null;
  surface: Surface;
  score_array: ScoreArray;
  result: MatchResult;
  sets_won: number;
  sets_lost: number;
  games_won: number;
  games_lost: number;
  match_score: number;
  streak_modifier: number;
  rpe_index: number | null;
  duration_minutes: number | null;
  notes: string | null;
  is_tiebreak: boolean;
  played_at: string;
  created_at: string;
}

/** A denormalised match card as served to the feed. */
export interface MatchCard extends Match {
  author_username: string;
  author_display_name: string;
  author_avatar_url: string | null;
  court_name: string | null;
  court_city: string | null;
  court_lat: number | null;
  court_lng: number | null;
  opponent_username: string | null;
  opponent_display_name: string | null;
  kudos_count: number;
  comment_count: number;
  viewer_has_kudos?: boolean;
  stats?: MatchStats | null;
}

export interface Territory {
  id: string;
  user_id: string;
  /** GeoJSON Polygon geometry (coordinates are [lng, lat]). */
  geometry: GeoJsonPolygon;
  center: { lat: number; lng: number };
  court_count: number;
  area_sqkm: number;
  district_name: string;
  court_ids: string[];
  updated_at: string;
  owner_username?: string;
  owner_display_name?: string;
}

export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

export interface LeaderboardEntry {
  court_id: string;
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  score: number;
  matches_played: number;
  wins: number;
  losses: number;
  games_won: number;
  games_lost: number;
  rank: number;
  last_played_at: string;
}

export interface StreakState {
  current_streak_weeks: number;
  longest_streak_weeks: number;
  streak_modifier: number;
  last_match_at: string | null;
}

export interface SurfaceRating {
  surface: Surface;
  rating: number;
  matches_played: number;
  wins: number;
  losses: number;
  peak_rating: number;
}

export interface Achievement {
  code: string;
  title: string;
  description: string;
  icon: string;
  created_at: string;
}

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  created_at: string;
}

/** The shape encoded into the JWT and attached to authenticated requests. */
export interface AuthClaims {
  sub: string; // user id
  username: string;
}
