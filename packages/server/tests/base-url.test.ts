import { afterEach, describe, expect, it } from "vitest";
import { buildActorUrl, buildEventUrl, buildProfileUrl, buildUploadUrl, getBaseUrl, getBaseUrlFromRequest } from "../src/lib/base-url.js";

const originalBaseUrl = process.env.BASE_URL;

afterEach(() => {
  if (originalBaseUrl === undefined) {
    delete process.env.BASE_URL;
  } else {
    process.env.BASE_URL = originalBaseUrl;
  }
});

describe("getBaseUrl", () => {
  it("uses default localhost when BASE_URL is unset", () => {
    delete process.env.BASE_URL;
    expect(getBaseUrl()).toBe("http://localhost:3000");
  });

  it("normalizes trailing slash and default HTTPS port", () => {
    process.env.BASE_URL = "https://events.example.com:443/";
    expect(getBaseUrl()).toBe("https://events.example.com");
  });

  it("drops query and hash and trims whitespace", () => {
    process.env.BASE_URL = "  https://events.example.com/root/?q=1#frag  ";
    expect(getBaseUrl()).toBe("https://events.example.com/root");
  });

  it("uses provided fallback when BASE_URL is blank", () => {
    process.env.BASE_URL = "   ";
    expect(getBaseUrl("https://fallback.example.com/")).toBe("https://fallback.example.com");
  });
});

describe("base URL builders", () => {
  it("builds actor, profile, and upload URLs from base URL", () => {
    const baseUrl = "https://events.example.com";
    expect(buildActorUrl("alice", baseUrl)).toBe("https://events.example.com/users/alice");
    expect(buildProfileUrl("alice", baseUrl)).toBe("https://events.example.com/@alice");
    expect(buildUploadUrl("image.webp", baseUrl)).toBe("https://events.example.com/uploads/image.webp");
  });

  it("builds event URL for local and remote-style usernames", () => {
    const baseUrl = "https://events.example.com";
    expect(buildEventUrl("alice", "launch-party", null, baseUrl)).toBe("https://events.example.com/@alice/launch-party");
    expect(buildEventUrl("alice@example.net", "launch-party", "example.net", baseUrl)).toBe("https://events.example.com/@alice@example.net/launch-party");
  });
});

describe("getBaseUrlFromRequest", () => {
  it("prefers BASE_URL when present", () => {
    process.env.BASE_URL = "https://events.example.com/";
    expect(getBaseUrlFromRequest("https://request-origin.example.org/path")).toBe("https://events.example.com");
  });

  it("falls back to request origin when BASE_URL is unset", () => {
    delete process.env.BASE_URL;
    expect(getBaseUrlFromRequest("https://request-origin.example.org/path")).toBe("https://request-origin.example.org");
  });
});
