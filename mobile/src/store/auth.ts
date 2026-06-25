import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, setAuthToken } from '../api/client';
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
      },

      setUser: (user) => set({ user }),

      refreshMe: async () => {
        if (!get().token) return;
        try {
          const { user } = await api.me();
          set({ user });
        } catch {
          // token likely expired — sign out cleanly
          get().logout();
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
