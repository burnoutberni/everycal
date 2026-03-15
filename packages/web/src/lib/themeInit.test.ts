// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const themeInitSource = readFileSync(join(process.cwd(), "public/theme-init.js"), "utf8");

function runThemeInit() {
  window.eval(themeInitSource);
}

describe("theme-init", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-storage-key");
    document.documentElement.style.colorScheme = "";
    const bootstrapEl = document.getElementById("everycal-bootstrap");
    bootstrapEl?.remove();
  });

  it("reads storage key from SSR-injected html attribute", () => {
    document.documentElement.setAttribute("data-theme-storage-key", "custom-theme-key");
    window.localStorage.setItem("custom-theme-key", "dark");
    window.localStorage.setItem("everycal-theme-preference", "light");

    runThemeInit();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });
});
