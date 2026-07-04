import { API_BASE } from './config';
import type {
  Achievement,
  AuthResponse,
  BlockedUser,
  Court,
  GeocodeResult,
  Goal,
  GoalMetric,
  GoalPeriod,
  HeadToHead,
  LeaderboardEntry,
  MatchCard,
  NotificationItem,
  ProfileAnalytics,
  ProfileResponse,
  ReverseGeocodeResult,
  ScheduledMatchCard,
  ScoreArray,
  StreakState,
  Surface,
  SurfaceRating,
  Territory,
} from '../types';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let authToken: string | null = null;
export function setAuthToken(token: string | null): void {
  authToken = token;
}

/**
 * Registered by the auth store so the client can trigger a clean sign-out when
 * a request comes back 401 and the session could not be refreshed, without
 * importing the store directly (which would be a circular dependency).
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/**
 * Registered by the auth store. On a 401 the client asks for a fresh access
 * token (Supabase refreshSession) and retries the request once — a token that
 * expired while the app was backgrounded must not tear down a refreshable
 * session. Resolves to the new token, or null when the session is truly dead.
 */
let refreshSession: (() => Promise<string | null>) | null = null;
export function setSessionRefresher(fn: (() => Promise<string | null>) | null): void {
  refreshSession = fn;
}

// Single-flight: concurrent 401s share one refresh instead of stampeding.
let refreshInFlight: Promise<string | null> | null = null;
function refreshOnce(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (refreshSession ? refreshSession() : Promise.resolve(null))
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

/** Abort a request that hangs so the UI never spins forever. */
const REQUEST_TIMEOUT_MS = 15_000;

async function doFetch(path: string, options: RequestInit, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${API_BASE}${path}`, { ...options, headers, signal: controller.signal });
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    throw new ApiError(
      0,
      aborted ? 'timeout' : 'network_error',
      aborted
        ? 'The Vollo server took too long to respond. Try again.'
        : 'Could not reach the Vollo server. Check your connection.',
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res = await doFetch(path, options, authToken);

  if (res.status === 401 && authToken) {
    // The token may simply have expired while the app was backgrounded — try a
    // refresh and one retry before declaring the session dead and signing out.
    const fresh = await refreshOnce();
    // Guard on authToken again: if the user signed out while the refresh was
    // in flight (setAuthToken(null) via the auth bridge), a late-resolving
    // refresh must not resurrect the cleared token or trigger a sign-out loop.
    if (fresh && authToken) {
      authToken = fresh;
      res = await doFetch(path, options, fresh);
    }
    if (res.status === 401 && authToken) onUnauthorized?.();
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, 'bad_response', 'The server returned an unexpected response.');
    }
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(res.status, err?.code ?? 'error', err?.message ?? 'Request failed');
  }
  return json as T;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  return entries.length ? `?${entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : '';
};

export interface CommentItem {
  id: string;
  body: string;
  created_at: string;
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

export interface UserSearchResult {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  viewer_is_following: boolean;
}

export interface CreateMatchPayload {
  opponent_id?: string;
  opponent_name?: string;
  court_id?: string;
  scheduled_match_id?: string;
  surface: Surface;
  title?: string;
  photo_url?: string;
  score_array: ScoreArray;
  is_tiebreak?: boolean;
  rpe_index?: number;
  duration_minutes?: number;
  notes?: string;
  played_at?: string;
  stats?: Partial<MatchCard['stats']>;
}

/** Session returned by the server-side sign-in proxy; fed straight into
 *  supabase.auth.setSession so the client owns the refreshable session. */
export interface SessionTokens {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  token_type?: string;
}

export interface CreateScheduledMatchPayload {
  opponent_id?: string;
  opponent_name?: string;
  court_id?: string;
  surface?: Surface;
  scheduled_at: string;
  note?: string;
  /** Frame the proposal as a competitive challenge (combative copy + push). */
  is_challenge?: boolean;
}

export const api = {
  // ── Auth ──
  // Sign-up runs client-side via Supabase Auth (see store/auth.ts); sign-in is
  // proxied server-side so a username resolves to a session without the email
  // ever reaching the client. `checkUsername` powers the sign-up "handle taken"
  // check and discloses no email.
  login: (identifier: string, password: string) =>
    request<{ session: SessionTokens }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    }),
  checkUsername: (username: string) =>
    request<{ available: boolean }>(`/auth/username-available${qs({ username })}`),
  me: () => request<{ user: AuthResponse['user'] }>('/auth/me'),

  // ── Feed ──
  getFeed: (params: { scope?: 'global' | 'following'; before?: string; limit?: number }) =>
    request<{ matches: MatchCard[]; next_cursor: string | null }>(`/feed${qs(params)}`),
  getUserFeed: (userId: string, params: { before?: string; limit?: number } = {}) =>
    request<{ matches: MatchCard[]; next_cursor: string | null }>(`/feed/user/${userId}${qs(params)}`),

  // ── Matches ──
  createMatch: (body: CreateMatchPayload) =>
    request<{ match: MatchCard }>('/matches', { method: 'POST', body: JSON.stringify(body) }),
  getMatch: (id: string) => request<{ match: MatchCard }>(`/matches/${id}`),
  deleteMatch: (id: string) => request<void>(`/matches/${id}`, { method: 'DELETE' }),
  // Matches awaiting my confirmation (I'm the tagged opponent).
  getPendingMatches: () => request<{ matches: MatchCard[] }>('/matches/pending'),
  // The tagged opponent confirms (it counts) or rejects (it never counts).
  verifyMatch: (id: string, action: 'confirm' | 'reject') =>
    request<{ match: MatchCard }>(`/matches/${id}/verify`, { method: 'POST', body: JSON.stringify({ action }) }),
  addKudos: (id: string) =>
    request<{ kudos_count: number; viewer_has_kudos: boolean }>(`/matches/${id}/kudos`, { method: 'POST' }),
  removeKudos: (id: string) =>
    request<{ kudos_count: number; viewer_has_kudos: boolean }>(`/matches/${id}/kudos`, { method: 'DELETE' }),
  getComments: (id: string) =>
    request<{ comments: CommentItem[] }>(`/matches/${id}/comments`),
  addComment: (id: string, body: string) =>
    request<{ comment: CommentItem }>(`/matches/${id}/comments`, { method: 'POST', body: JSON.stringify({ body }) }),

  // ── Courts ──
  getCourts: (params: { lat?: number; lng?: number; radius_km?: number; q?: string; limit?: number }) =>
    request<{ courts: Court[] }>(`/courts${qs(params)}`),
  // Returns every court (OSM-imported + user-added) inside the viewport.
  // `discover: false` is the instant first paint — it skips the slow Overpass
  // import and just reads the DB, so the map never blocks on the network. The
  // caller then re-runs with discover: true in the background to pull in new
  // real-world courts.
  discoverCourts: (
    bbox: { min_lng: number; min_lat: number; max_lng: number; max_lat: number },
    opts: { discover?: boolean } = {},
  ) =>
    request<{ courts: Court[] }>(
      `/courts/discover${qs({ ...bbox, import: opts.discover === false ? 0 : 1 })}`,
    ),
  reverseGeocode: (lat: number, lng: number) =>
    request<{ result: ReverseGeocodeResult | null }>(`/courts/reverse-geocode${qs({ lat, lng })}`),
  getCourt: (id: string) =>
    request<{ court: Court; controller: { user_id: string; username: string; display_name: string; score: number } | null }>(
      `/courts/${id}`,
    ),
  getCourtLeaderboard: (id: string) =>
    request<{ leaderboard: LeaderboardEntry[] }>(`/courts/${id}/leaderboard`),
  createCourt: (body: { name: string; surface: Surface; lat: number; lng: number; city?: string; address?: string; description?: string; court_count?: number }) =>
    request<{ court: Court }>('/courts', { method: 'POST', body: JSON.stringify(body) }),
  geocode: (q: string, limit = 5) => request<{ results: GeocodeResult[] }>(`/courts/geocode${qs({ q, limit })}`),

  // ── Scheduled matches ──
  getScheduledMatches: () =>
    request<{ scheduled_matches: ScheduledMatchCard[] }>('/scheduled-matches'),
  createScheduledMatch: (body: CreateScheduledMatchPayload) =>
    request<{ scheduled_match: ScheduledMatchCard }>('/scheduled-matches', { method: 'POST', body: JSON.stringify(body) }),
  respondToScheduledMatch: (id: string, action: 'accept' | 'decline' | 'cancel') =>
    request<{ scheduled_match: ScheduledMatchCard }>(`/scheduled-matches/${id}`, { method: 'PATCH', body: JSON.stringify({ action }) }),

  // ── Territories ──
  getTerritories: (bbox?: { min_lng: number; min_lat: number; max_lng: number; max_lat: number }) =>
    request<{ territories: Territory[] }>(`/territories${bbox ? qs(bbox) : ''}`),
  getUserTerritories: (userId: string) =>
    request<{ territories: Territory[] }>(`/territories/user/${userId}`),

  // ── Users / profiles ──
  searchUsers: (q: string, limit = 20) =>
    request<{ users: UserSearchResult[] }>(`/users/search${qs({ q, limit })}`),
  deleteAccount: () => request<void>('/users/me', { method: 'DELETE' }),
  getProfile: (username: string) => request<ProfileResponse>(`/users/${username}`),
  updateProfile: (body: Record<string, unknown>) =>
    request<{ user: AuthResponse['user'] }>('/users/me', { method: 'PATCH', body: JSON.stringify(body) }),
  follow: (username: string) => request<{ ok: boolean }>(`/users/${username}/follow`, { method: 'POST' }),
  unfollow: (username: string) => request<void>(`/users/${username}/follow`, { method: 'DELETE' }),
  // ── Goals ──
  getGoals: () => request<{ goals: Goal[] }>('/users/me/goals'),
  setGoal: (body: { metric: GoalMetric; period: GoalPeriod; target: number }) =>
    request<{ ok: boolean }>('/users/me/goals', { method: 'POST', body: JSON.stringify(body) }),
  deleteGoal: (id: string) => request<void>(`/users/me/goals/${id}`, { method: 'DELETE' }),

  blockUser: (username: string) => request<{ ok: boolean }>(`/users/${username}/block`, { method: 'POST' }),
  unblockUser: (username: string) => request<void>(`/users/${username}/block`, { method: 'DELETE' }),
  getBlockedUsers: () => request<{ users: BlockedUser[] }>('/users/me/blocks'),
  getAnalytics: (username: string) => request<{ analytics: ProfileAnalytics }>(`/users/${username}/analytics`),
  getRatings: (username: string) => request<{ ratings: SurfaceRating[] }>(`/users/${username}/ratings`),
  getAchievements: (username: string) => request<{ achievements: Achievement[] }>(`/users/${username}/achievements`),
  getStreak: (username: string) => request<{ streak: StreakState }>(`/users/${username}/streak`),
  getHeadToHead: (username: string) => request<{ head_to_head: HeadToHead[] }>(`/users/${username}/head-to-head`),
  registerPushToken: (token: string, platform: string) =>
    request<{ ok: boolean }>('/users/me/push-token', { method: 'POST', body: JSON.stringify({ token, platform }) }),

  // ── Notifications ──
  getNotifications: () =>
    request<{ notifications: NotificationItem[]; unread_count: number }>('/notifications'),
  markNotificationsRead: (ids?: string[]) =>
    request<{ ok: boolean }>('/notifications/read', { method: 'POST', body: JSON.stringify({ ids }) }),
};
