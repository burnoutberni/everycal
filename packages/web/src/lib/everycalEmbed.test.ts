import { describe, expect, it } from "vitest";
import { buildShowOnEverycalEmbedCode, normalizeEmbeddableEverycalPath } from "./everycalEmbed";

describe("everycalEmbed", () => {
  it("accepts profile and event paths", () => {
    expect(normalizeEmbeddableEverycalPath("/@alice")).toBe("/@alice");
    expect(normalizeEmbeddableEverycalPath("/@alice/launch-party")).toBe("/@alice/launch-party");
    expect(normalizeEmbeddableEverycalPath("/@alice@remote.example/launch-party")).toBe("/@alice@remote.example/launch-party");
  });

  it("rejects unsupported paths", () => {
    expect(normalizeEmbeddableEverycalPath("/events/123")).toBeNull();
    expect(normalizeEmbeddableEverycalPath("/@alice?view=list")).toBe("/@alice");
    expect(normalizeEmbeddableEverycalPath("/@alice#top")).toBe("/@alice");
    expect(normalizeEmbeddableEverycalPath("")).toBeNull();
  });

  it("builds script and button snippet", () => {
    const code = buildShowOnEverycalEmbedCode("/@alice", "https://everycal.example", "lg");
    expect(code).toContain('<script src="https://everycal.example/embed/show-on-everycal.js" defer></script>');
    expect(code).toContain('<everycal-button href="https://everycal.example/@alice" size="lg"></everycal-button>');
  });
});
