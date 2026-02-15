import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { auth as authApi, type User } from "../lib/api";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>(null!);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = async () => {
    try {
      const u = await authApi.me();
      setUser(u);
    } catch {
      setUser(null);
    }
  };

  // Always check session on mount — the HttpOnly cookie is sent automatically
  useEffect(() => {
    refreshUser().finally(() => setLoading(false));
  }, []);

  const login = async (username: string, password: string) => {
    const res = await authApi.login(username, password);
    // Server sets HttpOnly cookie — we just track the user in state
    setUser(res.user);
  };

  const register = async (username: string, password: string, displayName?: string) => {
    const res = await authApi.register(username, password, displayName);
    // Server sets HttpOnly cookie — we just track the user in state
    setUser(res.user);
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } catch {
      // ignore
    }
    // Server clears HttpOnly cookie
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
