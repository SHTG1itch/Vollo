import { API_BASE } from './config';
import { SessionGeneration } from '../utils/sessionGeneration';
import type {
  Achievement,
  AuthResponse,
  BlockedUser,
  CalendarMonth,
  Club,
  ClubLeaderboardEntry,
  ClubMember,
  Court,
  FollowRequest,
  GeocodeResult,
  Goal,
  GoalMetric,
  GoalPeriod,
  HeadToHead,
  LeaderboardEntry,
  MatchCard,
  NotificationItem,
  PersonalRecords,
  ProfileAnalytics,
  ProfileResponse,
  ReverseGeocodeResult,
  ScheduledMatchCard,
  ScoreArray,
  StreakState,
  Surface,
  SurfaceRating,
  Territory,
  YearInReview,
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
const authGeneration = new SessionGeneration();
let sessionAbortController = new AbortController();

/** The generation captured by account-owned store operations. */
export function getAuthGeneration(): number {
  return authGeneration.capture();
}

export function isAuthGenerationCurrent(generation: number): boolean {
  return authGeneration.isCurrent(generation);
}

/**
 * Mirror the current Supabase token and account identity into the API client.
 * Token rotation for one account remains in the same generation. Signing in,
 * signing out, or changing accounts invalidates every old request.
 */
export function setAuthToken(token: string | null, accountId: string | null): void {
  authToken = token;
  if (authGeneration.updateAccount(token ? accountId : null)) {
    sessionAbortController.abort();
    sessionAbortController = new AbortController();
  }
}

/**
 * Registered by the auth store so the client can trigger a clean sign-out when
 * a request comes back 401 and the session could not be refreshed, without
 * importing the store directly (which would be a circular dependency).
 */
let onUnauthorized: ((generation: number) => void) | null = null;
export function setUnauthorizedHandler(fn: ((generation: number) => void) | null): void {
  onUnauthorized = fn;
}

/**
 * Registered by the auth store. On a 401 the client asks for a fresh access
 * token (Supabase refreshSession) and retries the request once — a token that
 * expired while the app was backgrounded must not tear down a refreshable
 * session. Resolves to the new token, or null when the session is truly dead.
 */
let refreshSession: ((generation: number) => Promise<string | null>) | null = null;
export function setSessionRefresher(fn: ((generation: number) => Promise<string | null>) | null): void {
  refreshSession = fn;
}

// Single-flight within one generation. A new account must never join a refresh
// that was started by the account it replaced.
let refreshInFlight: { generation: number; promise: Promise<string | null> } | null = null;
function refreshOnce(generation: number): Promise<string | null> {
  if (refreshInFlight?.generation === generation) return refreshInFlight.promise;

  let promise: Promise<string | null>;
  promise = (refreshSession ? refreshSession(generation) : Promise.resolve(null))
    .catch(() => null)
    .then((fresh) => (authGeneration.isCurrent(generation) ? fresh : null))
    .finally(() => {
      if (refreshInFlight?.promise === promise) refreshInFlight = null;
    });
  refreshInFlight = { generation, promise };
  return promise;
}

/** Abort a request that hangs so the UI never spins forever. */
const REQUEST_TIMEOUT_MS = 15_000;

function staleSessionError(): ApiError {
  return new ApiError(0, 'stale_session', 'This request belonged to a previous sign-in session.');
}

function assertCurrentGeneration(generation: number): void {
  if (!authGeneration.isCurrent(generation)) throw staleSessionError();
}

async function doFetch(
  path: string,
  options: RequestInit,
  token: string | null,
  sessionSignal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const callerSignal = options.signal;
  const abort = () => controller.abort();
  let timedOut = false;

  if (sessionSignal?.aborted || callerSignal?.aborted) controller.abort();
  sessionSignal?.addEventListener('abort', abort, { once: true });
  callerSignal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${API_BASE}${path}`, { ...options, headers, signal: controller.signal });
  } catch (e) {
    if (sessionSignal?.aborted) throw staleSessionError();
    const cancelled = callerSignal?.aborted;
    const aborted = timedOut || (e instanceof Error && e.name === 'AbortError');
    throw new ApiError(
      0,
      cancelled ? 'request_cancelled' : aborted ? 'timeout' : 'network_error',
      cancelled
        ? 'The request was cancelled.'
        : aborted
          ? 'The Vollo server took too long to respond. Try again.'
          : 'Could not reach the Vollo server. Check your connection.',
    );
  } finally {
    clearTimeout(timeout);
    sessionSignal?.removeEventListener('abort', abort);
    callerSignal?.removeEventListener('abort', abort);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const generation = authGeneration.capture();
  const token = authToken;
  const sessionSignal = sessionAbortController.signal;
  let res = await doFetch(path, options, token, sessionSignal);
  assertCurrentGeneration(generation);

  if (res.status === 401 && token) {
    // The token may simply have expired while the app was backgrounded. Refresh
    // and retry only inside the generation that dispatched the original call.
    const fresh = await refreshOnce(generation);
    assertCurrentGeneration(generation);
    if (fresh) {
      authToken = fresh;
      res = await doFetch(path, options, fresh, sessionSignal);
      assertCurrentGeneration(generation);
    }
    if (res.status === 401) {
      onUnauthorized?.(generation);
      assertCurrentGeneration(generation);
    }
  }

  if (res.status === 204) return undefined as T;

  let text: string;
  try {
    text = await res.text();
  } catch {
    assertCurrentGeneration(generation);
    throw new ApiError(res.status, 'bad_response', 'The server returned an unreadable response.');
  }
  assertCurrentGeneration(generation);
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

/**
 * Fire-and-forget request used only for old-token cleanup during logout. It
 * snapshots the bearer and never retries, parses, or exposes its response.
 */
function sendBestEffort(path: string, options: RequestInit): void {
  const token = authToken;
  if (!token) return;
  void doFetch(path, options, token).catch(() => {});
}

/** Encode a URL path segment — user-supplied ids/usernames must never be able
 *  to inject extra path segments or query strings into the request path. */
const seg = (value: string): string => encodeURIComponent(value);

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
  is_private: boolean;
  viewer_is_following: boolean;
  /** Pending follow request awaiting this (private) player's approval. */
  viewer_has_requested: boolean;
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
  /** Client-generated idempotency key — the server dedupes retried submissions on it. */
  client_key?: string;
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
    request<{ matches: MatchCard[]; next_cursor: string | null }>(`/feed/user/${seg(userId)}${qs(params)}`),

  // ── Matches ──
  createMatch: (body: CreateMatchPayload) =>
    request<{ match: MatchCard }>('/matches', { method: 'POST', body: JSON.stringify(body) }),
  getMatch: (id: string) => request<{ match: MatchCard }>(`/matches/${seg(id)}`),
  deleteMatch: (id: string) => request<void>(`/matches/${seg(id)}`, { method: 'DELETE' }),
  // Matches awaiting my confirmation (I'm the tagged opponent).
  getPendingMatches: () => request<{ matches: MatchCard[] }>('/matches/pending'),
  // The tagged opponent confirms (it counts) or rejects (it never counts).
  verifyMatch: (id: string, action: 'confirm' | 'reject') =>
    request<{ match: MatchCard }>(`/matches/${seg(id)}/verify`, { method: 'POST', body: JSON.stringify({ action }) }),
  addKudos: (id: string) =>
    request<{ kudos_count: number; viewer_has_kudos: boolean }>(`/matches/${seg(id)}/kudos`, { method: 'POST' }),
  removeKudos: (id: string) =>
    request<{ kudos_count: number; viewer_has_kudos: boolean }>(`/matches/${seg(id)}/kudos`, { method: 'DELETE' }),
  getComments: (id: string) =>
    request<{ comments: CommentItem[] }>(`/matches/${seg(id)}/comments`),
  addComment: (id: string, body: string) =>
    request<{ comment: CommentItem }>(`/matches/${seg(id)}/comments`, { method: 'POST', body: JSON.stringify({ body }) }),

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
      `/courts/${seg(id)}`,
    ),
  getCourtLeaderboard: (id: string) =>
    request<{ leaderboard: LeaderboardEntry[] }>(`/courts/${seg(id)}/leaderboard`),
  createCourt: (body: { name: string; surface: Surface; lat: number; lng: number; city?: string; address?: string; description?: string; court_count?: number }) =>
    request<{ court: Court }>('/courts', { method: 'POST', body: JSON.stringify(body) }),
  geocode: (q: string, limit = 5) => request<{ results: GeocodeResult[] }>(`/courts/geocode${qs({ q, limit })}`),

  // ── Scheduled matches ──
  getScheduledMatches: () =>
    request<{ scheduled_matches: ScheduledMatchCard[] }>('/scheduled-matches'),
  createScheduledMatch: (body: CreateScheduledMatchPayload) =>
    request<{ scheduled_match: ScheduledMatchCard }>('/scheduled-matches', { method: 'POST', body: JSON.stringify(body) }),
  respondToScheduledMatch: (id: string, action: 'accept' | 'decline' | 'cancel') =>
    request<{ scheduled_match: ScheduledMatchCard }>(`/scheduled-matches/${seg(id)}`, { method: 'PATCH', body: JSON.stringify({ action }) }),

  // ── Clubs ──
  getClubs: (q?: string, limit = 50) => request<{ clubs: Club[] }>(`/clubs${qs({ q, limit })}`),
  getMyClubs: () => request<{ clubs: Club[] }>('/clubs/mine'),
  createClub: (body: { name: string; description?: string; city?: string }) =>
    request<{ club: Club }>('/clubs', { method: 'POST', body: JSON.stringify(body) }),
  getClub: (id: string) => request<{ club: Club; members: ClubMember[] }>(`/clubs/${seg(id)}`),
  joinClub: (id: string) => request<{ ok: boolean }>(`/clubs/${seg(id)}/join`, { method: 'POST' }),
  leaveClub: (id: string) => request<void>(`/clubs/${seg(id)}/join`, { method: 'DELETE' }),
  getClubLeaderboard: (id: string) =>
    request<{ leaderboard: ClubLeaderboardEntry[] }>(`/clubs/${seg(id)}/leaderboard`),
  getClubFeed: (id: string, params: { before?: string; limit?: number } = {}) =>
    request<{ matches: MatchCard[]; next_cursor: string | null }>(`/clubs/${seg(id)}/feed${qs(params)}`),

  // ── Territories ──
  getTerritories: (bbox?: { min_lng: number; min_lat: number; max_lng: number; max_lat: number }) =>
    request<{ territories: Territory[] }>(`/territories${bbox ? qs(bbox) : ''}`),
  getUserTerritories: (userId: string) =>
    request<{ territories: Territory[] }>(`/territories/user/${seg(userId)}`),

  // ── Users / profiles ──
  searchUsers: (q: string, limit = 20) =>
    request<{ users: UserSearchResult[] }>(`/users/search${qs({ q, limit })}`),
  deleteAccount: () => request<void>('/users/me', { method: 'DELETE' }),
  getProfile: (username: string) => request<ProfileResponse>(`/users/${seg(username)}`),
  updateProfile: (body: Record<string, unknown>) =>
    request<{ user: AuthResponse['user'] }>('/users/me', { method: 'PATCH', body: JSON.stringify(body) }),
  // Following a private account yields status 'requested' until approved.
  follow: (username: string) =>
    request<{ ok: boolean; status: 'following' | 'requested' }>(`/users/${seg(username)}/follow`, { method: 'POST' }),
  // Also withdraws a pending follow request.
  unfollow: (username: string) => request<void>(`/users/${seg(username)}/follow`, { method: 'DELETE' }),
  getFollowRequests: () => request<{ requests: FollowRequest[] }>('/users/me/follow-requests'),
  respondFollowRequest: (userId: string, action: 'accept' | 'decline') =>
    request<{ ok: boolean }>(`/users/me/follow-requests/${seg(userId)}`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  // ── Goals ──
  getGoals: () => request<{ goals: Goal[] }>('/users/me/goals'),
  setGoal: (body: { metric: GoalMetric; period: GoalPeriod; target: number }) =>
    request<{ ok: boolean }>('/users/me/goals', { method: 'POST', body: JSON.stringify(body) }),
  deleteGoal: (id: string) => request<void>(`/users/me/goals/${seg(id)}`, { method: 'DELETE' }),

  blockUser: (username: string) => request<{ ok: boolean }>(`/users/${seg(username)}/block`, { method: 'POST' }),
  unblockUser: (username: string) => request<void>(`/users/${seg(username)}/block`, { method: 'DELETE' }),
  getBlockedUsers: () => request<{ users: BlockedUser[] }>('/users/me/blocks'),
  getAnalytics: (username: string) => request<{ analytics: ProfileAnalytics }>(`/users/${seg(username)}/analytics`),
  getRatings: (username: string) => request<{ ratings: SurfaceRating[] }>(`/users/${seg(username)}/ratings`),
  getAchievements: (username: string) => request<{ achievements: Achievement[] }>(`/users/${seg(username)}/achievements`),
  getStreak: (username: string) => request<{ streak: StreakState }>(`/users/${seg(username)}/streak`),
  getHeadToHead: (username: string) => request<{ head_to_head: HeadToHead[] }>(`/users/${seg(username)}/head-to-head`),
  getRecords: (username: string) => request<{ records: PersonalRecords }>(`/users/${seg(username)}/records`),
  getYearInReview: (username: string, year: number) =>
    request<{ review: YearInReview }>(
      `/users/${seg(username)}/year-in-review${qs({ year, tz_offset: new Date().getTimezoneOffset() })}`,
    ),
  // tz_offset buckets days in the viewer's local time.
  getCalendar: (username: string, year: number, month: number) =>
    request<CalendarMonth>(
      `/users/${seg(username)}/calendar${qs({ year, month, tz_offset: new Date().getTimezoneOffset() })}`,
    ),
  registerPushToken: (token: string, platform: string) =>
    request<{ ok: boolean }>('/users/me/push-token', { method: 'POST', body: JSON.stringify({ token, platform }) }),
  // Detached cleanup: it keeps A's captured bearer, never retries as B, and
  // cannot delay clearing the local session.
  unregisterPushTokenBestEffort: (token: string) =>
    sendBestEffort('/users/me/push-token', { method: 'DELETE', body: JSON.stringify({ token }) }),

  // ── Notifications ──
  getNotifications: () =>
    request<{ notifications: NotificationItem[]; unread_count: number }>('/notifications'),
  markNotificationsRead: (ids?: string[]) =>
    request<{ ok: boolean }>('/notifications/read', { method: 'POST', body: JSON.stringify({ ids }) }),
};
