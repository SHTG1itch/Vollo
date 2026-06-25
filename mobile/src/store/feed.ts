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
    set({ scope, matches: [], cursor: null });
    void get().fetch(true);
  },

  fetch: async (refresh = false) => {
    set(refresh ? { refreshing: true, error: null } : { loading: true, error: null });
    try {
      const { matches, next_cursor } = await api.getFeed({ scope: get().scope, limit: 20 });
      set({ matches, cursor: next_cursor });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load feed' });
    } finally {
      set({ loading: false, refreshing: false });
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
    const before = get().matches;
    const target = before.find((m) => m.id === matchId);
    if (!target) return;
    const wasKudosed = target.viewer_has_kudos ?? false;

    set({
      matches: before.map((m) =>
        m.id === matchId
          ? { ...m, viewer_has_kudos: !wasKudosed, kudos_count: m.kudos_count + (wasKudosed ? -1 : 1) }
          : m,
      ),
    });

    try {
      const res = wasKudosed ? await api.removeKudos(matchId) : await api.addKudos(matchId);
      set({
        matches: get().matches.map((m) =>
          m.id === matchId ? { ...m, kudos_count: res.kudos_count, viewer_has_kudos: res.viewer_has_kudos } : m,
        ),
      });
    } catch {
      set({ matches: before }); // revert
    }
  },
}));
