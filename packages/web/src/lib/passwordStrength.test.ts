import { describe, expect, it } from "vitest";
import { evaluatePasswordStrength } from "./passwordStrength";

describe("evaluatePasswordStrength", () => {
  it("marks lowercase-only passwords meeting min length as weak", () => {
    const result = evaluatePasswordStrength("password");
    expect(result.level).toBe("weak");
    expect(result.checks.minLength).toBe(true);
    expect(result.checks.mixedCase).toBe(false);
    expect(result.checks.number).toBe(false);
    expect(result.checks.symbol).toBe(false);
  });

  it("marks mixed-case + number passwords as good", () => {
    const result = evaluatePasswordStrength("Password1");
    expect(result.level).toBe("good");
    expect(result.score).toBe(3);
  });

  it("keeps too-short passwords weak even with mixed case, number, and symbol", () => {
    const result = evaluatePasswordStrength("Aa1!");
    expect(result.level).toBe("weak");
    expect(result.score).toBe(0);
    expect(result.checks.minLength).toBe(false);
    expect(result.checks.mixedCase).toBe(true);
    expect(result.checks.number).toBe(true);
    expect(result.checks.symbol).toBe(true);
  });

  it("marks passwords meeting all checks as strong", () => {
    const result = evaluatePasswordStrength("Password1!");
    expect(result.level).toBe("strong");
    expect(result.score).toBe(4);
  });

  it("treats non-ASCII letters as letters for mixed case and symbol checks", () => {
    const result = evaluatePasswordStrength("Äßbcdef1!");
    expect(result.checks.mixedCase).toBe(true);
    expect(result.checks.number).toBe(true);
    expect(result.checks.symbol).toBe(true);
  });

  it("does not count whitespace as a symbol", () => {
    const result = evaluatePasswordStrength("Password1 ");
    expect(result.level).toBe("good");
    expect(result.score).toBe(3);
    expect(result.checks.symbol).toBe(false);
  });

  it("does not treat umlauts alone as symbols", () => {
    const result = evaluatePasswordStrength("PasswordÄ1");
    expect(result.checks.symbol).toBe(false);
  });

  it("supports a custom minimum length", () => {
    const result = evaluatePasswordStrength("Password1!", 12);
    expect(result.level).toBe("weak");
    expect(result.score).toBe(0);
    expect(result.checks.minLength).toBe(false);
  });
});
