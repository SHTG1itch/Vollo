import { create } from 'zustand';
import { api } from '../api/client';
import type { NotificationItem } from '../types';

interface NotificationState {
  items: NotificationItem[];
  unread: number;
  loading: boolean;
  fetch: () => Promise<void>;
  markAllRead: () => Promise<void>;
}

export const useNotifications = create<NotificationState>((set, get) => ({
  items: [],
  unread: 0,
  loading: false,

  fetch: async () => {
    set({ loading: true });
    try {
      const { notifications, unread_count } = await api.getNotifications();
      set({ items: notifications, unread: unread_count });
    } catch {
      /* silently ignore */
    } finally {
      set({ loading: false });
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
}));
