import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { createTransportMock, sendMailMock } = vi.hoisted(() => ({
  createTransportMock: vi.fn(),
  sendMailMock: vi.fn(async () => undefined),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: createTransportMock,
  },
}));

const originalEnv = { ...process.env };

function restoreEnv(envSnapshot: NodeJS.ProcessEnv): void {
  const existingKeys = Object.keys(process.env);

  Object.assign(process.env, envSnapshot);

  for (const key of existingKeys) {
    if (!(key in envSnapshot)) {
      delete process.env[key];
    }
  }
}

function clearSmtpEnv(): void {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_FROM;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_SECURE;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  restoreEnv(originalEnv);
  clearSmtpEnv();
  createTransportMock.mockReturnValue({ sendMail: sendMailMock });
});

afterAll(() => {
  restoreEnv(originalEnv);
});

describe("email fallback when SMTP is missing", () => {
  it("logs registration verification link in non-production", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.BASE_URL;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sendVerificationEmail } = await import("../src/lib/email.js");

    await sendVerificationEmail("dev@example.com", "verify-token", "en");

    expect(logSpy).toHaveBeenCalledWith("[dev] Verification link: http://localhost:3000/verify-email?token=verify-token");
    expect(warnSpy).toHaveBeenCalledWith(
      "[dev] BASE_URL is not set; email links will use http://localhost:3000. Set BASE_URL to your local app URL if needed."
    );
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("logs email change and password reset links in non-production", async () => {
    process.env.NODE_ENV = "development";
    process.env.BASE_URL = "http://localhost:4173";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sendEmailChangeVerificationEmail, sendPasswordResetEmail } = await import("../src/lib/email.js");

    await sendEmailChangeVerificationEmail("dev@example.com", "change-token", "en");
    await sendPasswordResetEmail("dev@example.com", "reset-token", "en");

    expect(logSpy).toHaveBeenCalledWith("[dev] Email change verification link: http://localhost:4173/verify-email?token=change-token");
    expect(logSpy).toHaveBeenCalledWith("[dev] Reset link: http://localhost:4173/reset-password?token=reset-token");
    expect(warnSpy).not.toHaveBeenCalledWith(
      "[dev] BASE_URL is not set; email links will use http://localhost:3000. Set BASE_URL to your local app URL if needed."
    );
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("never logs token links in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.BASE_URL;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sendVerificationEmail, sendEmailChangeVerificationEmail, sendPasswordResetEmail } = await import("../src/lib/email.js");

    await sendVerificationEmail("prod@example.com", "verify-prod-token", "en");
    await sendEmailChangeVerificationEmail("prod@example.com", "change-prod-token", "en");
    await sendPasswordResetEmail("prod@example.com", "reset-prod-token", "en");

    expect(logSpy).not.toHaveBeenCalled();
    const warnedText = warnSpy.mock.calls.flat().join(" ");
    expect(warnedText).toContain("verification email not sent");
    expect(warnedText).toContain("email change verification not sent");
    expect(warnedText).toContain("password reset email not sent");
    expect(warnedText).not.toContain("verify-prod-token");
    expect(warnedText).not.toContain("change-prod-token");
    expect(warnedText).not.toContain("reset-prod-token");
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
