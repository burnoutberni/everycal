import { describe, expect, it } from "vitest";
import { parseRemoteHandle } from "../src/lib/remote-handle.js";

describe("parseRemoteHandle", () => {
  it("accepts canonical remote handles with optional port", () => {
    expect(parseRemoteHandle("alice@example.com")).toEqual({ localPart: "alice", domain: "example.com" });
    expect(parseRemoteHandle("alice@example.com:8443")).toEqual({ localPart: "alice", domain: "example.com:8443" });
    expect(parseRemoteHandle("alice@EXAMPLE.com:08443")).toEqual({ localPart: "alice", domain: "example.com:8443" });
  });

  it("accepts IDN hostnames and normalizes to ASCII", () => {
    expect(parseRemoteHandle("alice@bücher.example")).toEqual({
      localPart: "alice",
      domain: "xn--bcher-kva.example",
    });
    expect(parseRemoteHandle("alice@bücher.example:8443")).toEqual({
      localPart: "alice",
      domain: "xn--bcher-kva.example:8443",
    });
  });

  it("rejects URL-like and malformed payloads", () => {
    const invalid = [
      "",
      "alice",
      "alice@",
      "@example.com",
      "alice@example.com/path",
      "alice@example.com?x=1",
      "alice@example.com#frag",
      "alice@https://example.com",
      "alice@@example.com",
      "alice@example.com:",
      "alice@example.com:0",
      "alice@example.com:65536",
      "alice@example.com:abc",
      "alice@example.com:8443:9443",
      "alice@[::1]:8443",
      "alice@localhost",
      "alice@127.0.0.1",
      "ali ce@example.com",
    ];

    for (const value of invalid) {
      expect(parseRemoteHandle(value)).toBeNull();
    }
  });
});
