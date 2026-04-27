import { describe, expect, it } from "vitest";
import { PASSWORD_MIN_LENGTH, isValidHttpUrl, meetsPasswordMinLength } from "./validators";

describe("meetsPasswordMinLength", () => {
  it("enforces the default minimum length", () => {
    expect(meetsPasswordMinLength("a".repeat(PASSWORD_MIN_LENGTH - 1))).toBe(false);
    expect(meetsPasswordMinLength("a".repeat(PASSWORD_MIN_LENGTH))).toBe(true);
  });

  it("supports custom minimum lengths", () => {
    expect(meetsPasswordMinLength("abcdef", 6)).toBe(true);
    expect(meetsPasswordMinLength("abcde", 6)).toBe(false);
  });
});

describe("isValidHttpUrl", () => {
  it("rejects localhost and private addresses by default", () => {
    expect(isValidHttpUrl("http://localhost:5173/path")).toBe(false);
    expect(isValidHttpUrl("https://10.0.0.4/resource")).toBe(false);
    expect(isValidHttpUrl("https://192.168.1.15/resource")).toBe(false);
    expect(isValidHttpUrl("https://100.64.0.1/resource")).toBe(false);
    expect(isValidHttpUrl("https://198.19.1.10/resource")).toBe(false);
    expect(isValidHttpUrl("https://203.0.113.20/resource")).toBe(false);
    expect(isValidHttpUrl("https://[::1]/resource")).toBe(false);
    expect(isValidHttpUrl("https://[::]/resource")).toBe(false);
    expect(isValidHttpUrl("https://[2001:db8::1]/resource")).toBe(false);
  });

  it("accepts localhost when explicitly allowed", () => {
    expect(isValidHttpUrl("http://localhost:5173/path", { allowLocalhost: true })).toBe(true);
  });

  it("accepts private network addresses only when explicitly allowed", () => {
    expect(isValidHttpUrl("https://10.0.0.4/resource", { allowPrivateHosts: true })).toBe(true);
    expect(isValidHttpUrl("https://192.168.1.15/resource", { allowPrivateHosts: true })).toBe(true);
    expect(isValidHttpUrl("https://[::1]/resource", { allowPrivateHosts: true })).toBe(true);
  });

  it("continues to accept public HTTP(S) URLs", () => {
    expect(isValidHttpUrl("https://example.com/path")).toBe(true);
    expect(isValidHttpUrl("http://example.com/path")).toBe(true);
    expect(isValidHttpUrl("https://8.8.8.8/path")).toBe(true);
  });
});
