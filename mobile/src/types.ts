// Client-side mirror of the Vollo API DTOs.

export type Surface = 'hard' | 'clay' | 'grass' | 'indoor';
export type MatchResult = 'win' | 'loss';
export type SetScore = [number, number];
export type ScoreArray = SetScore[];

/** A match against a Vollo player starts 'pending' and only counts once the
 *  opponent confirms it; matches with no Vollo opponent are 'auto'. */
export type VerificationStatus = 'auto' | 'pending' | 'verified' | 'rejected';

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
  /** Wide banner image shown behind the profile header. */
  cover_url: string | null;
  bio: string | null;
  dominant_hand: 'right' | 'left';
  /** Signature colour (#RRGGBB) used to wash this player's territories. */
  color: string | null;
  home_lat: number | null;
  home_lng: number | null;
  home_label: string | null;
  equipment: Equipment;
  /** Private account: matches/stats visible only to followers. */
  is_private: boolean;
  /** Turf War visibility: territories + court/club leaderboard entries are
   *  public when true, hidden from everyone (never follower-gated) when false. */
  show_competitive: boolean;
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
  /** Stable identity for an imported facility; null for user-added courts. */
  sector_key: string | null;
  /** Number of physical courts this facility holds (a "sector"). */
  court_count: number;
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
  /** Optional short headline for the match, shown on the feed card. */
  title: string | null;
  /** Optional proof-of-play photo (public Storage URL). */
  photo_url: string | null;
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
  verification_status: VerificationStatus;
  verified_at: string | null;
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
  /** Owner's signature colour (#RRGGBB), or null when unset. */
  owner_color?: string | null;
  /** Owner's verified wins across this zone's courts (30-day window) — the bar a
   *  rival must clear to start claiming the territory. */
  owner_zone_wins?: number;
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
  /** Bayesian rating deviation (σ) — uncertainty. High = provisional/new. */
  rating_deviation: number;
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
  by_surface: {
    surface: Surface;
    matches: number;
    wins: number;
    losses: number;
    win_rate: number;
    games_won: number;
    games_lost: number;
  }[];
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
  recent_form: ('W' | 'L')[];
  avg_rpe: number;
}

export type ScheduleStatus = 'proposed' | 'accepted' | 'declined' | 'cancelled' | 'completed';

export interface ScheduledMatchCard {
  id: string;
  creator_id: string;
  creator_username: string;
  creator_display_name: string;
  creator_avatar_url: string | null;
  opponent_id: string | null;
  opponent_username: string | null;
  opponent_display_name: string | null;
  opponent_avatar_url: string | null;
  opponent_name: string | null;
  court_id: string | null;
  court_name: string | null;
  surface: Surface | null;
  scheduled_at: string;
  note: string | null;
  status: ScheduleStatus;
  /** True when framed as a competitive challenge rather than a plain plan. */
  is_challenge: boolean;
  match_id: string | null;
  /** Score of the linked, played match (logger's games first) — shown to both. */
  result_score: ScoreArray | null;
  result_logged_by: string | null;
  /** Which side the viewer is on, for rendering the right actions. */
  viewer_role: 'creator' | 'opponent';
  created_at: string;
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
  /** Pending follow request awaiting this (private) profile's approval. */
  viewer_has_requested: boolean;
  /** The viewer has blocked this player (offer "Unblock"). */
  viewer_has_blocked: boolean;
  /** Private profile the viewer doesn't follow — content sections are hidden. */
  restricted: boolean;
}

/** All-time personal bests (trophy case). Sections are null until earned. */
export interface PersonalRecords {
  total_matches: number;
  first_match_at: string | null;
  longest_win_streak: { count: number; started_at: string; ended_at: string } | null;
  peak_rating: { surface: Surface; rating: number } | null;
  biggest_win: { match_id: string; score_array: ScoreArray; margin: number; played_at: string } | null;
  most_aces: { match_id: string; aces: number; played_at: string } | null;
  longest_match: { match_id: string; duration_minutes: number; played_at: string } | null;
  busiest_month: { month: string; matches: number } | null;
  comeback_wins: number;
}

/** An open group with a shared feed and a 30-day member leaderboard. */
export interface Club {
  id: string;
  name: string;
  description: string | null;
  city: string | null;
  creator_id: string | null;
  member_count: number;
  viewer_is_member: boolean;
  created_at: string;
}

export interface ClubMember {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  role: 'admin' | 'member';
  joined_at: string;
}

export interface ClubLeaderboardEntry {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  matches_played: number;
  wins: number;
  score: number;
  rank: number;
}

/** One calendar day's activity in the training log. */
export interface CalendarDay {
  date: string; // YYYY-MM-DD (viewer-local)
  matches: number;
  wins: number;
  minutes: number;
  items: { id: string; result: MatchResult; score_array: ScoreArray }[];
}

export interface CalendarMonth {
  year: number;
  month: number; // 1-based
  days: CalendarDay[];
  totals: { matches: number; wins: number; minutes: number };
}

/** A season's recap (the "Year in Sport" analog). */
export interface YearInReview {
  year: number;
  totals: {
    matches: number;
    wins: number;
    losses: number;
    minutes: number;
    games_won: number;
    aces: number;
    kudos_received: number;
  };
  monthly: { month: number; matches: number; wins: number }[];
  top_opponent: { name: string; matches: number; wins: number; losses: number } | null;
  favorite_court: { court_id: string; name: string; matches: number } | null;
  favorite_surface: { surface: Surface; matches: number; win_rate: number } | null;
  longest_win_streak: number;
}

export type GoalMetric = 'matches' | 'wins' | 'hours';
export type GoalPeriod = 'weekly' | 'monthly';

/** A personal weekly/monthly target; `current` is progress in the live period. */
export interface Goal {
  id: string;
  metric: GoalMetric;
  period: GoalPeriod;
  target: number;
  current: number;
  created_at: string;
}

/** An incoming follow request on a private account. */
export interface FollowRequest {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  requested_at: string;
}

export interface BlockedUser {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  blocked_at: string;
}

export interface GeocodeResult {
  label: string;
  lat: number;
  lng: number;
  city: string | null;
}

export interface ReverseGeocodeResult {
  label: string;
  city: string | null;
  /** Neighbourhood/suburb used to name anonymous courts; may be absent. */
  neighborhood?: string | null;
}
