import { create } from 'zustand';
import { api, getAuthGeneration, isAuthGenerationCurrent } from '../api/client';
import { RequestGeneration } from '../utils/sessionGeneration';
import type { MatchCard } from '../types';
import { showToast } from '../components/Toast';

type Scope = 'global' | 'following';

interface FeedState {
  matches: MatchCard[];
  scope: Scope;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  cursor: string | null;
  error: string | null;
  setScope: (scope: Scope) => void;
  fetch: (refresh?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  prepend: (match: MatchCard) => void;
  toggleKudos: (matchId: string) => Promise<void>;
  reset: () => void;
}

// A monotonic token so a slow fetch for a previous scope can't overwrite the
// results of a newer one (e.g. rapid Global↔Following toggles).
const feedRequests = new RequestGeneration();
const feedState = new RequestGeneration();
// matchIds with a kudos request in flight — guards against racing add/remove
// from rapid double-taps.
const kudosInFlight = new Map<string, symbol>();

function isCurrent(request: number, session: number): boolean {
  return feedRequests.isCurrent(request) && isAuthGenerationCurrent(session);
}

function isCurrentState(state: number, session: number): boolean {
  return feedState.isCurrent(state) && isAuthGenerationCurrent(session);
}

export const useFeed = create<FeedState>((set, get) => ({
  matches: [],
  scope: 'global',
  loading: false,
  refreshing: false,
  loadingMore: false,
  cursor: null,
  error: null,

  setScope: (scope) => {
    if (scope === get().scope) return;
    // Invalidate any in-flight fetch/loadMore for the old scope immediately.
    feedRequests.invalidate();
    feedState.invalidate();
    // Show the loader (not the empty state) while the new scope loads.
    set({ scope, matches: [], cursor: null, loading: true, loadingMore: false, error: null });
    void get().fetch(false);
  },

  fetch: async (refresh = false) => {
    const token = feedRequests.next();
    const session = getAuthGeneration();
    const scope = get().scope;
    set(
      refresh
        ? { refreshing: true, loadingMore: false, error: null }
        : { loading: true, loadingMore: false, error: null },
    );
    try {
      const { matches, next_cursor } = await api.getFeed({ scope, limit: 20 });
      if (!isCurrent(token, session)) return; // a newer fetch/session superseded this one
      set({ matches, cursor: next_cursor });
    } catch (e) {
      if (!isCurrent(token, session)) return;
      set({ error: e instanceof Error ? e.message : 'Failed to load feed' });
    } finally {
      if (isCurrent(token, session)) set({ loading: false, refreshing: false });
    }
  },

  loadMore: async () => {
    const { cursor, loadingMore, scope } = get();
    if (!cursor || loadingMore) return;
    // Capture the token so a slow page for a superseded scope (or a logged-out
    // session, via reset) is discarded instead of clobbering the newer feed.
    const token = feedRequests.capture();
    const session = getAuthGeneration();
    set({ loadingMore: true });
    try {
      const res = await api.getFeed({ scope, before: cursor, limit: 20 });
      if (!isCurrent(token, session)) return; // scope/session changed while in flight
      // Append onto the CURRENT list, not the one captured before the await.
      set({ matches: [...get().matches, ...res.matches], cursor: res.next_cursor });
    } catch {
      if (isCurrent(token, session)) showToast('Could not load more matches — please try again.', 'error');
    } finally {
      if (isCurrent(token, session)) set({ loadingMore: false });
    }
  },

  prepend: (match) => set({ matches: [match, ...get().matches] }),

  // Optimistic: flip the UI immediately, reconcile with the server, revert on error.
  toggleKudos: async (matchId) => {
    // Ignore a tap while a request for this match is already in flight, so a
    // rapid double-tap can't fire racing add/remove calls that desync the count.
    if (kudosInFlight.has(matchId)) return;
    const target = get().matches.find((m) => m.id === matchId);
    if (!target) return;
    const wasKudosed = target.viewer_has_kudos ?? false;
    const state = feedState.capture();
    const session = getAuthGeneration();
    const operation = Symbol(matchId);

    const applyDelta = (kudosed: boolean) =>
      set({
        matches: get().matches.map((m) =>
          m.id === matchId
            ? { ...m, viewer_has_kudos: kudosed, kudos_count: Math.max(0, m.kudos_count + (kudosed ? 1 : -1)) }
            : m,
        ),
      });

    applyDelta(!wasKudosed);
    kudosInFlight.set(matchId, operation);

    try {
      const res = wasKudosed ? await api.removeKudos(matchId) : await api.addKudos(matchId);
      if (!isCurrentState(state, session) || kudosInFlight.get(matchId) !== operation) return;
      // Reconcile only this item from the authoritative server counts.
      set({
        matches: get().matches.map((m) =>
          m.id === matchId ? { ...m, kudos_count: res.kudos_count, viewer_has_kudos: res.viewer_has_kudos } : m,
        ),
      });
    } catch {
      if (!isCurrentState(state, session) || kudosInFlight.get(matchId) !== operation) return;
      // Revert just this item — don't clobber concurrent feed updates.
      applyDelta(wasKudosed);
      showToast('Could not update kudos — please try again.', 'error');
    } finally {
      if (kudosInFlight.get(matchId) === operation) kudosInFlight.delete(matchId);
    }
  },

  reset: () => {
    // Invalidate in-flight requests so a late page can't repopulate the feed
    // (e.g. the previous user's matches after logout), and drop stale kudos locks.
    feedRequests.invalidate();
    feedState.invalidate();
    kudosInFlight.clear();
    set({ matches: [], scope: 'global', loading: false, refreshing: false, loadingMore: false, cursor: null, error: null });
  },
}));
