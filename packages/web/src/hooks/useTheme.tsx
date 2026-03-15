import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  applyThemeToDocument,
  getSystemTheme,
  readStoredThemePreference,
  resolveTheme,
  writeStoredThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "../lib/theme";

type ThemeContextValue = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (value: ThemePreference, options?: { persist?: boolean }) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredThemePreference());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(readStoredThemePreference(), getSystemTheme()));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      setResolvedTheme(applyThemeToDocument(preference));
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (preference !== "system") return;
      setResolvedTheme(applyThemeToDocument("system"));
    };

    setResolvedTheme(applyThemeToDocument(preference));
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onSystemChange);
      return () => media.removeEventListener("change", onSystemChange);
    }
    media.addListener(onSystemChange);
    return () => media.removeListener(onSystemChange);
  }, [preference]);

  const setPreference = useCallback((value: ThemePreference, options?: { persist?: boolean }) => {
    setPreferenceState(value);
    if (options?.persist ?? true) {
      writeStoredThemePreference(value);
    }
  }, []);

  const contextValue = useMemo(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme],
  );

  return <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
