import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { AppBootstrap } from "@everycal/core";
import { bootstrapViewerToUser } from "@everycal/core";
import { auth as authApi, type User, type AuthResponse } from "../lib/api";
import { syncLanguageFromUser } from "../i18n";

export type AuthStatus = "unknown" | "authenticated" | "anonymous";

type AuthState = {
  status: AuthStatus;
  user: User | null;
};

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  authStatus: AuthStatus;
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

export function initAuthFromBootstrap(bootstrap?: AppBootstrap): AuthState {
  if (!bootstrap) {
    return {
      status: "unknown",
      user: null,
    };
  }
  const user = bootstrapViewerToUser(bootstrap.viewer) ?? null;
  return {
    status: bootstrap.isAuthenticated ? "authenticated" : "anonymous",
    user,
  };
}

export function AuthProvider({
  children,
  initialUser,
  initialBootstrap,
}: {
  children: ReactNode;
  initialUser?: User | null;
  initialBootstrap?: AppBootstrap;
}) {
  const bootstrapState = initAuthFromBootstrap(initialBootstrap);
  const hasBootstrap = initialBootstrap !== undefined || initialUser !== undefined;
  const [authState, setAuthState] = useState<AuthState>(() => {
    if (initialBootstrap) return bootstrapState;
    if (initialUser === undefined) return { status: "unknown", user: null };
    return { status: initialUser ? "authenticated" : "anonymous", user: initialUser ?? null };
  });

  const refreshUser = async () => {
    try {
      const u = await authApi.me();
      setAuthState({ status: "authenticated", user: u });
      syncLanguageFromUser(u.preferredLanguage);
    } catch {
      setAuthState({ status: "anonymous", user: null });
    }
  };

  // If bootstrap provided auth certainty, keep first paint stable and refresh in background.
  useEffect(() => {
    if (hasBootstrap) {
      let cancelDeferred: (() => void) | undefined;
      if (typeof window !== "undefined" && "requestIdleCallback" in window && "cancelIdleCallback" in window) {
        const idleId = window.requestIdleCallback(() => {
          refreshUser().catch(() => {});
        });
        cancelDeferred = () => window.cancelIdleCallback(idleId);
      } else {
        const timeoutId = setTimeout(() => {
          refreshUser().catch(() => {});
        }, 500);
        cancelDeferred = () => clearTimeout(timeoutId);
      }

      return () => cancelDeferred?.();
    }

    refreshUser().catch(() => {});
  }, []);

  const login = async (username: string, password: string) => {
    const res = await authApi.login(username, password);
    setAuthState({ status: "authenticated", user: res.user });
    syncLanguageFromUser(res.user.preferredLanguage);
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
    setAuthState({ status: "authenticated", user: (res as AuthResponse).user });
  };

  const logout = async () => {
    try {
      await authApi.logout();
    } catch {
      // ignore
    }
    // Server clears HttpOnly cookie
    setAuthState({ status: "anonymous", user: null });
  };

  return (
    <AuthContext.Provider
      value={{
        user: authState.user,
        loading: authState.status === "unknown",
        authStatus: authState.status,
        login,
        register,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
