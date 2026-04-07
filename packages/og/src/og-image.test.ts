import { afterEach, describe, expect, it, vi } from "vitest";
import type { EveryCalEvent } from "@everycal/core";

const { satoriMock, htmlMock, sharpMock } = vi.hoisted(() => {
  const hoistedSatoriMock = vi.fn().mockResolvedValue("<svg></svg>");
  const hoistedHtmlMock = vi.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      let out = "";
      for (let i = 0; i < strings.length; i += 1) {
        out += strings[i];
        if (i < values.length) {
          out += String(values[i]);
        }
      }
      return out;
    }
  );

  const hoistedSharpMock = vi.fn((input: Buffer) => {
    let resized = false;
    let composited = false;

    const api = {
      metadata: vi.fn(async () => ({ format: "jpeg" })),
      resize: vi.fn(() => {
        resized = true;
        return api;
      }),
      composite: vi.fn(() => {
        composited = true;
        return api;
      }),
      png: vi.fn(() => api),
      toBuffer: vi.fn(async () => {
        if (composited) return Buffer.from("final-png");
        if (resized) return Buffer.from("resized-header-png");
        if (input.toString().includes("linearGradient")) {
          return Buffer.from("gradient-png");
        }
        if (input.toString() === "<svg></svg>") return Buffer.from("svg-png");
        return Buffer.from("raw-png");
      }),
    };

    return api;
  });

  return {
    satoriMock: hoistedSatoriMock,
    htmlMock: hoistedHtmlMock,
    sharpMock: hoistedSharpMock,
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("font-data")),
}));

vi.mock("satori", () => ({
  default: satoriMock,
}));

vi.mock("satori-html", () => ({
  html: htmlMock,
}));

vi.mock("sharp", () => ({
  default: sharpMock,
}));

import { generateOgImage, getOgImageFilename } from "./og-image.js";

function buildEvent(overrides: Partial<EveryCalEvent> = {}): EveryCalEvent {
  return {
    id: "https://example.com/events/1",
    title: "Community Picnic",
    startDate: "2026-08-15T18:00:00.000Z",
    endDate: "2026-08-15T20:00:00.000Z",
    startAtUtc: "2026-08-15T18:00:00.000Z",
    visibility: "public",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("getOgImageFilename", () => {
  it("adds png extension to event id", () => {
    expect(getOgImageFilename("event-123")).toBe("event-123.png");
  });
});

describe("generateOgImage", () => {
  it("returns rendered PNG when no header image is provided", async () => {
    const buffer = await generateOgImage({
      event: buildEvent(),
      locale: "en",
    });

    expect(buffer).toEqual(Buffer.from("svg-png"));
    expect(satoriMock).toHaveBeenCalledOnce();

    const markup = satoriMock.mock.calls[0]?.[0] as string;
    expect(markup).toContain("Community Picnic");
  });

  it("escapes unsafe event text before rendering", async () => {
    await generateOgImage({
      event: buildEvent({
        title: "<script>alert(1)</script>",
        location: {
          name: "<Hall>",
          address: "Main & 2nd",
        },
      }),
      locale: "en",
    });

    const markup = satoriMock.mock.calls.at(-1)?.[0] as string;
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).toContain("&lt;Hall&gt;");
    expect(markup).toContain("Main &amp; 2nd");
  });

  it("falls back to plain OG render when header fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unavailable"))
    );

    const buffer = await generateOgImage({
      event: buildEvent({
        image: { url: "https://example.com/unreachable.jpg" },
      }),
      locale: "en",
    });

    expect(buffer).toEqual(Buffer.from("svg-png"));
  });

  it("composites header image when fetch succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    }));

    const buffer = await generateOgImage({
      event: buildEvent({
        image: { url: "https://example.com/header.jpg" },
      }),
      locale: "en",
    });

    expect(buffer).toEqual(Buffer.from("final-png"));
  });

  it("formats timed events using event timezone", async () => {
    await generateOgImage({
      event: buildEvent({
        startDate: "2026-08-15T18:00:00.000Z",
        endDate: "2026-08-15T20:00:00.000Z",
        startAtUtc: "2026-08-15T18:00:00.000Z",
        endAtUtc: "2026-08-15T20:00:00.000Z",
        eventTimezone: "Europe/Vienna",
      }),
      locale: "en",
    });

    const markup = satoriMock.mock.calls.at(-1)?.[0] as string;
    expect(markup).toMatch(/8:00\s?PM\s?–\s?10:00\s?PM/);
  });

  it("falls back to UTC when timed event timezone is missing", async () => {
    await generateOgImage({
      event: buildEvent({
        startDate: "2026-08-15T18:00:00.000Z",
        endDate: "2026-08-15T20:00:00.000Z",
        startAtUtc: "2026-08-15T18:00:00.000Z",
        endAtUtc: "2026-08-15T20:00:00.000Z",
        eventTimezone: undefined,
      }),
      locale: "en",
    });

    const markup = satoriMock.mock.calls.at(-1)?.[0] as string;
    expect(markup).toMatch(/6:00\s?PM\s?–\s?8:00\s?PM/);
  });
});
