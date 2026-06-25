// Client-side mirror of the Vollo API DTOs.

export type Surface = 'hard' | 'clay' | 'grass' | 'indoor';
export type MatchResult = 'win' | 'loss';
export type SetScore = [number, number];
export type ScoreArray = SetScore[];

export interface User {
  id: string;
  username: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  dominant_hand: 'right' | 'left';
  home_lat: number | null;
  home_lng: number | null;
  home_label: string | null;
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
  created_by: string | null;
  created_at: string;
  distance_km?: number;
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

export interface MatchCard {
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

export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

export interface Territory {
  id: string;
  user_id: string;
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

export interface StreakState {
  current_streak_weeks: number;
  longest_streak_weeks: number;
  streak_modifier: number;
  last_match_at: string | null;
}

export interface HeadToHead {
  opponent_id: string | null;
  opponent_name: string;
  matches: number;
  wins: number;
  losses: number;
}

export interface ProfileAnalytics {
  overall: { matches: number; wins: number; losses: number; win_rate: number };
  by_surface: Array<{
    surface: Surface;
    matches: number;
    wins: number;
    losses: number;
    win_rate: number;
    games_won: number;
    games_lost: number;
  }>;
  serve: {
    first_serve_pct: number;
    second_serve_pct: number;
    aces: number;
    double_faults: number;
    break_point_conversion: number;
  };
  strokes: {
    forehand: { winners: number; errors: number; ratio: number };
    backhand: { winners: number; errors: number; ratio: number };
    volley: { winners: number; errors: number; ratio: number };
  };
  rally: {
    short: number;
    medium: number;
    long: number;
    short_pct: number;
    medium_pct: number;
    long_pct: number;
  };
  playstyle: string;
  recent_form: Array<'W' | 'L'>;
  avg_rpe: number;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read: boolean;
  created_at: string;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface ProfileResponse {
  user: User;
  stats: {
    match_count: number;
    follower_count: number;
    following_count: number;
    territory_count: number;
  };
  viewer_is_following: boolean;
}

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
  city: string | null;
}
