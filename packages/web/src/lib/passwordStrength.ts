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
    mixedCase: /[a-z]/.test(password) && /[A-Z]/.test(password),
    number: /\d/.test(password),
    symbol: /[^A-Za-z0-9]/.test(password),
  };

  const score = Number(checks.minLength)
    + Number(checks.mixedCase)
    + Number(checks.number)
    + Number(checks.symbol);

  if (!checks.minLength) {
    return { level: "weak", score, checks };
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
