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
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
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
});
