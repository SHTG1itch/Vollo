import { create } from 'zustand';
import { api } from '../api/client';
import type { NotificationItem } from '../types';

interface NotificationState {
  items: NotificationItem[];
  unread: number;
  loading: boolean;
  /** True only for an explicit pull-to-refresh, so the RefreshControl spinner
   *  doesn't fire on every background/focus refetch. */
  refreshing: boolean;
  error: string | null;
  fetch: (refresh?: boolean) => Promise<void>;
  markAllRead: () => Promise<void>;
  reset: () => void;
}

export const useNotifications = create<NotificationState>((set, get) => ({
  items: [],
  unread: 0,
  loading: false,
  refreshing: false,
  error: null,

  fetch: async (refresh = false) => {
    set(refresh ? { refreshing: true, error: null } : { loading: true, error: null });
    try {
      const { notifications, unread_count } = await api.getNotifications();
      set({ items: notifications, unread: unread_count });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load notifications' });
    } finally {
      set({ loading: false, refreshing: false });
    }
  },

  markAllRead: async () => {
    if (get().unread === 0) return;
    set({ items: get().items.map((n) => ({ ...n, read: true })), unread: 0 });
    try {
      await api.markNotificationsRead();
    } catch {
      void get().fetch();
    }
  },

  reset: () => set({ items: [], unread: 0, loading: false, refreshing: false, error: null }),
}));
