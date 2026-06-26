import { create } from 'zustand';
import { api } from '../api/client';
import type { MatchCard } from '../types';

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
let fetchToken = 0;
// matchIds with a kudos request in flight — guards against racing add/remove
// from rapid double-taps.
const kudosInFlight = new Set<string>();

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
    // Show the loader (not the empty state) while the new scope loads.
    set({ scope, matches: [], cursor: null, loading: true, error: null });
    void get().fetch(false);
  },

  fetch: async (refresh = false) => {
    const token = ++fetchToken;
    const scope = get().scope;
    set(refresh ? { refreshing: true, error: null } : { loading: true, error: null });
    try {
      const { matches, next_cursor } = await api.getFeed({ scope, limit: 20 });
      if (token !== fetchToken) return; // a newer fetch superseded this one
      set({ matches, cursor: next_cursor });
    } catch (e) {
      if (token !== fetchToken) return;
      set({ error: e instanceof Error ? e.message : 'Failed to load feed' });
    } finally {
      if (token === fetchToken) set({ loading: false, refreshing: false });
    }
  },

  loadMore: async () => {
    const { cursor, loadingMore, scope, matches } = get();
    if (!cursor || loadingMore) return;
    set({ loadingMore: true });
    try {
      const res = await api.getFeed({ scope, before: cursor, limit: 20 });
      set({ matches: [...matches, ...res.matches], cursor: res.next_cursor });
    } catch {
      /* keep what we have */
    } finally {
      set({ loadingMore: false });
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

    const applyDelta = (kudosed: boolean) =>
      set({
        matches: get().matches.map((m) =>
          m.id === matchId
            ? { ...m, viewer_has_kudos: kudosed, kudos_count: Math.max(0, m.kudos_count + (kudosed ? 1 : -1)) }
            : m,
        ),
      });

    applyDelta(!wasKudosed);
    kudosInFlight.add(matchId);

    try {
      const res = wasKudosed ? await api.removeKudos(matchId) : await api.addKudos(matchId);
      // Reconcile only this item from the authoritative server counts.
      set({
        matches: get().matches.map((m) =>
          m.id === matchId ? { ...m, kudos_count: res.kudos_count, viewer_has_kudos: res.viewer_has_kudos } : m,
        ),
      });
    } catch {
      // Revert just this item — don't clobber concurrent feed updates.
      applyDelta(wasKudosed);
    } finally {
      kudosInFlight.delete(matchId);
    }
  },

  reset: () => set({ matches: [], scope: 'global', loading: false, refreshing: false, loadingMore: false, cursor: null, error: null }),
}));
