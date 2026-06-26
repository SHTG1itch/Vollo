import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError, api, setAuthToken, setUnauthorizedHandler } from '../api/client';
import { useFeed } from './feed';
import { useNotifications } from './notifications';
import type { User } from '../types';

interface AuthState {
  user: User | null;
  token: string | null;
  hydrated: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  register: (body: { username: string; email: string; password: string; display_name: string }) => Promise<void>;
  logout: () => void;
  setUser: (user: User) => void;
  refreshMe: () => Promise<void>;
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      hydrated: false,

      login: async (identifier, password) => {
        const { user, token } = await api.login({ identifier, password });
        setAuthToken(token);
        set({ user, token });
      },

      register: async (body) => {
        const { user, token } = await api.register(body);
        setAuthToken(token);
        set({ user, token });
      },

      logout: () => {
        setAuthToken(null);
        set({ user: null, token: null });
        // Clear per-user caches so the next account never sees stale data.
        useFeed.getState().reset();
        useNotifications.getState().reset();
      },

      setUser: (user) => set({ user }),

      refreshMe: async () => {
        if (!get().token) return;
        try {
          const { user } = await api.me();
          set({ user });
        } catch (err) {
          // Only sign out when the token is actually rejected — a network blip
          // on cold start must NOT nuke a valid session.
          if (err instanceof ApiError && err.status === 401) get().logout();
        }
      },
    }),
    {
      name: 'vollo-auth',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ user: s.user, token: s.token }),
      onRehydrateStorage: () => (state) => {
        if (state?.token) setAuthToken(state.token);
        useAuth.setState({ hydrated: true });
      },
    },
  ),
);

// Any 401 from the API means the session is dead — sign out once, cleanly.
setUnauthorizedHandler(() => {
  if (useAuth.getState().token) useAuth.getState().logout();
});
