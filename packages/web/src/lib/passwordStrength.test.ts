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

  it("marks passwords meeting all checks as strong", () => {
    const result = evaluatePasswordStrength("Password1!");
    expect(result.level).toBe("strong");
    expect(result.score).toBe(4);
  });
});
