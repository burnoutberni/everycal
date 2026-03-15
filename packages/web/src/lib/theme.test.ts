// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  parseThemePreference,
  readStoredThemePreference,
  resolveTheme,
  writeStoredThemePreference,
} from "./theme";

describe("theme preference", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
    vi.restoreAllMocks();
  });

  it("defaults to system when no stored value exists", () => {
    expect(readStoredThemePreference()).toBe("system");
  });

  it("parses only valid preferences", () => {
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("auto")).toBeUndefined();
    expect(parseThemePreference(null)).toBeUndefined();
  });

  it("stores light and dark, removes key for system", () => {
    writeStoredThemePreference("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    writeStoredThemePreference("system");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("resolves theme with system fallback", () => {
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("light", "dark")).toBe("light");
  });

  it("applies explicit and system themes to document root", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));

    const dark = applyThemeToDocument("dark");
    expect(dark).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    const system = applyThemeToDocument("system");
    expect(system).toBe("dark");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });
});
