import { create } from 'zustand';
import * as Notifications from 'expo-notifications';
import { api } from '../api/client';
import type { NotificationItem } from '../types';

/** Best-effort: keep the app-icon badge in sync when everything is read.
 *  Badge APIs can throw in Expo Go / on denied permissions — never a blocker. */
function clearBadge(): void {
  void Notifications.setBadgeCountAsync(0).catch(() => {});
}

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
      if (unread_count === 0) clearBadge();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load notifications' });
    } finally {
      set({ loading: false, refreshing: false });
    }
  },

  markAllRead: async () => {
    if (get().unread === 0) return;
    set({ items: get().items.map((n) => ({ ...n, read: true })), unread: 0 });
    clearBadge();
    try {
      await api.markNotificationsRead();
    } catch {
      void get().fetch();
    }
  },

  reset: () => set({ items: [], unread: 0, loading: false, refreshing: false, error: null }),
}));
