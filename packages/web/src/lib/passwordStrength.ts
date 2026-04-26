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
    minLength: password.length >= 8,
    mixedCase: /[a-z]/.test(password) && /[A-Z]/.test(password),
    number: /\d/.test(password),
    symbol: /[^A-Za-z0-9]/.test(password),
  };

  const score = Number(checks.minLength)
    + Number(checks.mixedCase)
    + Number(checks.number)
    + Number(checks.symbol);

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
