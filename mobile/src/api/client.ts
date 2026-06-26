import { API_BASE } from './config';
import type {
  Achievement,
  AuthResponse,
  Court,
  GeocodeResult,
  HeadToHead,
  LeaderboardEntry,
  MatchCard,
  NotificationItem,
  ProfileAnalytics,
  ProfileResponse,
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
 * any request comes back 401 (expired/invalid token), without importing the
 * store directly (which would be a circular dependency).
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

/** Abort a request that hangs so the UI never spins forever. */
const REQUEST_TIMEOUT_MS = 15_000;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> | undefined),
  };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers, signal: controller.signal });
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

  if (res.status === 401) {
    // Expired/invalid session — let the app sign out before surfacing the error.
    onUnauthorized?.();
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
  surface: Surface;
  score_array: ScoreArray;
  rpe_index?: number;
  duration_minutes?: number;
  notes?: string;
  played_at?: string;
  stats?: Partial<MatchCard['stats']>;
}

export const api = {
  // ── Auth ──
  register: (body: { username: string; email: string; password: string; display_name: string }) =>
    request<AuthResponse>('/auth/register', { method: 'POST', body: JSON.stringify(body) }),
  login: (body: { identifier: string; password: string }) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),
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
  getCourt: (id: string) =>
    request<{ court: Court; controller: { user_id: string; username: string; display_name: string; score: number } | null }>(
      `/courts/${id}`,
    ),
  getCourtLeaderboard: (id: string) =>
    request<{ leaderboard: LeaderboardEntry[] }>(`/courts/${id}/leaderboard`),
  createCourt: (body: { name: string; surface: Surface; lat: number; lng: number; city?: string; address?: string; description?: string }) =>
    request<{ court: Court }>('/courts', { method: 'POST', body: JSON.stringify(body) }),
  geocode: (q: string, limit = 5) => request<{ results: GeocodeResult[] }>(`/courts/geocode${qs({ q, limit })}`),

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
