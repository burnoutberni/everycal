import { describe, expect, it } from "vitest";
import {
  buildLocaleCookie,
  parseAcceptLanguage,
  readLocaleCookie,
  resolveLocale,
  shouldSetLocaleCookie,
} from "../src/lib/locale.js";

describe("locale utilities", () => {
  it("parses accept-language by quality", () => {
    expect(parseAcceptLanguage("fr-AT;q=0.4,de-DE;q=0.8,en;q=0.7")).toBe("de");
    expect(parseAcceptLanguage("fr,es")).toBe("en");
    expect(parseAcceptLanguage(undefined)).toBe("en");
  });

  it("reads locale cookie safely", () => {
    expect(readLocaleCookie("foo=bar; everycal_locale=de")).toBe("de");
    expect(readLocaleCookie("everycal_locale=fr")).toBeUndefined();
    expect(readLocaleCookie(undefined)).toBeUndefined();
  });

  it("builds locale cookie", () => {
    const cookie = buildLocaleCookie("en");
    expect(cookie).toContain("everycal_locale=en");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("resolves locale precedence matrix", () => {
    expect(resolveLocale({ userPreferred: "de", cookieLocale: "en", acceptLanguage: "en-US,en;q=0.9" })).toBe("de");
    expect(resolveLocale({ userPreferred: null, cookieLocale: "de", acceptLanguage: "en-US,en;q=0.9" })).toBe("de");
    expect(resolveLocale({ userPreferred: null, cookieLocale: undefined, acceptLanguage: "de-DE,de;q=0.9" })).toBe("de");
    expect(resolveLocale({ userPreferred: null, cookieLocale: undefined, acceptLanguage: "fr-FR" })).toBe("en");
  });

  it("knows when locale cookie should be written", () => {
    expect(shouldSetLocaleCookie("everycal_locale=en", "en")).toBe(false);
    expect(shouldSetLocaleCookie("everycal_locale=de", "en")).toBe(true);
    expect(shouldSetLocaleCookie(undefined, "en")).toBe(true);
  });
});
