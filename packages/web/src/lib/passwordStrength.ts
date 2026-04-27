import { PASSWORD_MIN_LENGTH, meetsPasswordMinLength } from "@everycal/core";

export type PasswordStrengthLevel = "weak" | "fair" | "good" | "strong";

export type PasswordStrengthResult = {
  level: PasswordStrengthLevel;
  score: number;
  checks: {
    minLength: boolean;
    mixedCase: boolean;
    number: boolean;
    symbol: boolean;
  };
};

export function evaluatePasswordStrength(password: string): PasswordStrengthResult {
  const checks = {
    minLength: meetsPasswordMinLength(password, PASSWORD_MIN_LENGTH),
    mixedCase: /\p{Ll}/u.test(password) && /\p{Lu}/u.test(password),
    number: /\p{Nd}/u.test(password),
    symbol: /[^\p{L}\p{M}\p{N}\s]/u.test(password),
  };

  const score = Number(checks.minLength)
    + Number(checks.mixedCase)
    + Number(checks.number)
    + Number(checks.symbol);

  if (!checks.minLength) {
    return { level: "weak", score: 0, checks };
  }

  if (score <= 1) {
    return { level: "weak", score, checks };
  }
  if (score === 2) {
    return { level: "fair", score, checks };
  }
  if (score === 3) {
    return { level: "good", score, checks };
  }
  return { level: "strong", score, checks };
}
