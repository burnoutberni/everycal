import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./security";

describe("cloudflare password hashing", () => {
  it("hashes and verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("pbkdf2$")).toBe(true);
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("nope", hash)).resolves.toBe(false);
  });
});
