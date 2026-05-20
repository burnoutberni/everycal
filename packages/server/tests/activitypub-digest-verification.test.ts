import { describe, expect, it } from "vitest";
import { hasMatchingRequestDigest } from "../src/routes/activitypub.js";

describe("hasMatchingRequestDigest", () => {
  const rawBody = JSON.stringify({ hello: "world" });
  const validBase64 = "k6I5cakU5erL8KjSUVTNownDwccvu5kU1Hxg88toFYg=";

  it("accepts legacy Digest with canonical SHA-256 token", () => {
    expect(hasMatchingRequestDigest(rawBody, `SHA-256=${validBase64}`)).toBe(true);
  });

  it("accepts legacy Digest with lower-case algorithm and extra tokens", () => {
    expect(hasMatchingRequestDigest(rawBody, `md5=bogus, sha-256=${validBase64}`)).toBe(true);
  });

  it("accepts Content-Digest structured-field byte sequence", () => {
    expect(hasMatchingRequestDigest(rawBody, undefined, `sha-256=:${validBase64}:`)).toBe(true);
  });

  it("accepts Content-Digest when Digest is present but invalid", () => {
    expect(hasMatchingRequestDigest(rawBody, "SHA-256=invalid", `sha-256=:${validBase64}:`)).toBe(true);
  });

  it("rejects when both headers are missing", () => {
    expect(hasMatchingRequestDigest(rawBody)).toBe(false);
  });

  it("rejects when no sha-256 token exists", () => {
    expect(hasMatchingRequestDigest(rawBody, "md5=bogus", "sha-512=:bogus:")).toBe(false);
  });

  it("rejects mismatched sha-256 values", () => {
    expect(hasMatchingRequestDigest(rawBody, "sha-256=invalid")).toBe(false);
    expect(hasMatchingRequestDigest(rawBody, undefined, "sha-256=:invalid:")).toBe(false);
  });
});
