import { describe, expect, it } from "vitest";
import { decodeHtmlEntitiesOnce } from "./text.js";

describe("decodeHtmlEntitiesOnce", () => {
  it("decodes named entities", () => {
    expect(decodeHtmlEntitiesOnce("Radlobby Leopoldstadt &amp; Brigittenau - Bezirkstreffen"))
      .toBe("Radlobby Leopoldstadt & Brigittenau - Bezirkstreffen");
  });

  it("decodes numeric entities", () => {
    expect(decodeHtmlEntitiesOnce("Foo &#38; Bar &#8211; Baz")).toBe("Foo & Bar – Baz");
  });

  it("keeps plain text unchanged", () => {
    expect(decodeHtmlEntitiesOnce("Critical Mass Vienna")).toBe("Critical Mass Vienna");
  });

  it("decodes exactly once for double-encoded text", () => {
    expect(decodeHtmlEntitiesOnce("Rock &amp;amp; Roll")).toBe("Rock &amp; Roll");
  });
});
