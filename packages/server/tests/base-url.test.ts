import { afterEach, describe, expect, it } from "vitest";
import { buildActorUrl, buildEventUrl, buildProfileUrl, buildUploadUrl, buildUrl, getBaseUrl, getBaseUrlFromRequest, validateBaseUrlConfig } from "../src/lib/base-url.js";

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

  it("throws when BASE_URL is not an absolute URL", () => {
    process.env.BASE_URL = "localhost:3000";
    expect(() => getBaseUrl("https://fallback.example.com/")).toThrow();
  });

  it("throws when BASE_URL is invalid and no fallback is provided", () => {
    process.env.BASE_URL = "localhost:3000";
    expect(() => getBaseUrl()).toThrow();
  });
});

describe("base URL builders", () => {
  it("builds URLs with joined and encoded segments", () => {
    expect(buildUrl("https://events.example.com/", "events", "a b")).toBe("https://events.example.com/events/a%20b");
    expect(buildUrl("https://events.example.com", "@alice@example.net", "launch/party")).toBe("https://events.example.com/@alice@example.net/launch%2Fparty");
  });

  it("builds actor, profile, and upload URLs from base URL", () => {
    const baseUrl = "https://events.example.com";
    expect(buildActorUrl("alice", baseUrl)).toBe("https://events.example.com/users/alice");
    expect(buildProfileUrl("alice", baseUrl)).toBe("https://events.example.com/@alice");
    expect(buildUploadUrl("image.webp", baseUrl)).toBe("https://events.example.com/uploads/image.webp");
  });

  it("encodes unsafe path characters while preserving @", () => {
    const baseUrl = "https://events.example.com";
    expect(buildActorUrl("alice bob", baseUrl)).toBe("https://events.example.com/users/alice%20bob");
    expect(buildProfileUrl("alice@example.net", baseUrl)).toBe("https://events.example.com/@alice@example.net");
    expect(buildEventUrl("alice@example.net", "launch party", "example.net", baseUrl)).toBe("https://events.example.com/@alice@example.net/launch%20party");
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

describe("validateBaseUrlConfig", () => {
  it("throws when BASE_URL is unset", () => {
    delete process.env.BASE_URL;
    expect(() => validateBaseUrlConfig()).toThrow(/BASE_URL must be configured/);
  });

  it("throws when BASE_URL is blank", () => {
    process.env.BASE_URL = "   ";
    expect(() => validateBaseUrlConfig()).toThrow(/BASE_URL must be configured/);
  });

  it("throws a clear startup error when BASE_URL is invalid", () => {
    process.env.BASE_URL = "localhost:3000";
    expect(() => validateBaseUrlConfig()).toThrow(/Invalid BASE_URL configuration/);
  });

  it("accepts a valid absolute BASE_URL", () => {
    process.env.BASE_URL = "https://events.example.com/root/";
    expect(() => validateBaseUrlConfig()).not.toThrow();
  });
});
