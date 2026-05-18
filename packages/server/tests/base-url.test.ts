import { afterEach, describe, expect, it } from "vitest";
import { getBaseUrl } from "../src/lib/base-url.js";

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
