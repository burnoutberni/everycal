import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { auth as authApi, type User, type AuthResponse } from "../lib/api";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<User>;
  register: (
    username: string,
    password: string,
    displayName?: string,
    city?: string,
    cityLat?: number,
    cityLng?: number,
    email?: string
  ) => Promise<{ requiresVerification?: boolean; email?: string } | void>;
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
    setUser(res.user);
    return res.user;
  };

  const register = async (
    username: string,
    password: string,
    displayName?: string,
    city?: string,
    cityLat?: number,
    cityLng?: number,
    email?: string
  ) => {
    const res = await authApi.register(username, password, displayName, city, cityLat, cityLng, email);
    if ("requiresVerification" in res && res.requiresVerification) {
      return { requiresVerification: true, email: res.email };
    }
    setUser((res as AuthResponse).user);
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
