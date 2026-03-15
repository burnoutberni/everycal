export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "everycal-theme-preference";

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function readStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(stored) ? stored : "system";
}

export function writeStoredThemePreference(preference: ThemePreference): void {
  if (typeof window === "undefined") return;
  if (preference === "system") {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(THEME_STORAGE_KEY, preference);
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference, systemTheme: ResolvedTheme): ResolvedTheme {
  return preference === "system" ? systemTheme : preference;
}

export function applyThemeToDocument(preference: ThemePreference): ResolvedTheme {
  if (typeof document === "undefined") return "light";
  const root = document.documentElement;
  const resolved = resolveTheme(preference, getSystemTheme());

  if (preference === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", preference);
  }
  root.style.colorScheme = resolved;

  return resolved;
}
