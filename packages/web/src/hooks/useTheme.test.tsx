// @vitest-environment jsdom

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { THEME_STORAGE_KEY } from "../lib/theme";
import { ThemeProvider, useTheme } from "./useTheme";

function ThemeProbe() {
  const { preference } = useTheme();
  return <span>{preference}</span>;
}

describe("ThemeProvider", () => {
  let addEventListener: ReturnType<typeof vi.fn>;
  let removeEventListener: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      addEventListener,
      removeEventListener,
    }));
  });

  it("uses initialPreference over localStorage on first render", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    render(
      <ThemeProvider initialPreference="light">
        <ThemeProbe />
      </ThemeProvider>
    );

    expect(screen.getByText("light")).toBeTruthy();
  });

  it("falls back to localStorage when initialPreference is missing", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );

    expect(screen.getByText("dark")).toBeTruthy();
  });

  it("does not subscribe to system theme changes for explicit preferences", () => {
    render(
      <ThemeProvider initialPreference="light">
        <ThemeProbe />
      </ThemeProvider>
    );

    expect(addEventListener).not.toHaveBeenCalled();
    expect(removeEventListener).not.toHaveBeenCalled();
  });

  it("subscribes to system theme changes when preference is system", () => {
    render(
      <ThemeProvider initialPreference="system">
        <ThemeProbe />
      </ThemeProvider>
    );

    expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
