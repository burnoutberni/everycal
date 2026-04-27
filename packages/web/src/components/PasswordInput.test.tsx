// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PASSWORD_MIN_LENGTH } from "@everycal/core";
import { PasswordInput } from "./PasswordInput";
import * as passwordStrength from "../lib/passwordStrength";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { min?: number; rule?: string; status?: string }) => {
      if (key === "passwordRequirementMet") {
        return "met";
      }

      if (key === "passwordRequirementNotMet") {
        return "not met";
      }

      if (key === "passwordRequirementStateLabel") {
        return `${options?.rule} - ${options?.status}`;
      }

      if (key === "passwordRuleMinLength") {
        return `${key}:${options?.min}`;
      }

      return key;
    },
  }),
}));

describe("PasswordInput", () => {
  it("toggles password visibility with an accessible button", () => {
    render(
      <PasswordInput
        id="password"
        value="Password1!"
        onChange={() => {}}
        autoComplete="new-password"
      />
    );

    const input = document.getElementById("password") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocapitalize")).toBe("none");
    expect(input.getAttribute("autocorrect")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.minLength).toBe(-1);

    const toggle = screen.getByRole("button", { name: "showPassword" });
    fireEvent.click(toggle);

    expect((screen.getByRole("button", { name: "hidePassword" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    const visibleInput = document.getElementById("password") as HTMLInputElement;
    expect(visibleInput.type).toBe("text");
    expect(visibleInput.getAttribute("autocapitalize")).toBe("none");
    expect(visibleInput.getAttribute("autocorrect")).toBe("off");
    expect(visibleInput.getAttribute("spellcheck")).toBe("false");
  });

  it("applies minLength when provided", () => {
    const { container } = render(
      <PasswordInput
        id="password"
        value="Password1!"
        onChange={() => {}}
        minLength={PASSWORD_MIN_LENGTH}
      />
    );

    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.minLength).toBe(PASSWORD_MIN_LENGTH);
  });

  it("renders inline strength feedback and updates level text", () => {
    const { rerender } = render(
      <PasswordInput
        id="password"
        value="password"
        onChange={() => {}}
        showStrengthFeedback
      />
    );

    expect(screen.getByText(/passwordStrengthLabel:/)).toBeTruthy();
    expect(screen.getByText("passwordStrength.weak")).toBeTruthy();
    expect(screen.getByText("passwordRequiredLabel")).toBeTruthy();
    expect(screen.getByText("passwordTipsLabel")).toBeTruthy();

    const status = screen.getByRole("status");
    expect(status.getAttribute("id")).toBe("password-strength");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.parentElement?.getAttribute("aria-live")).toBeNull();

    expect(screen.queryByRole("checkbox", { name: "passwordRuleMinLength" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "passwordRuleMixedCase" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "passwordRuleNumber" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "passwordRuleSymbol" })).toBeNull();
    expect(screen.getByRole("listitem", { name: `passwordRuleMinLength:${PASSWORD_MIN_LENGTH} - met` })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "passwordRuleMixedCase - not met" })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "passwordRuleNumber - not met" })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "passwordRuleSymbol - not met" })).toBeTruthy();

    rerender(
      <PasswordInput
        id="password"
        value="Password1!"
        onChange={() => {}}
        showStrengthFeedback
      />
    );

    expect(screen.getByText("passwordStrength.strong")).toBeTruthy();
    expect(screen.getByRole("listitem", { name: `passwordRuleMinLength:${PASSWORD_MIN_LENGTH} - met` })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "passwordRuleMixedCase - met" })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "passwordRuleNumber - met" })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "passwordRuleSymbol - met" })).toBeTruthy();
  });

  it("does not fill strength meter segments when minimum length is not met", () => {
    const { container } = render(
      <PasswordInput
        id="password"
        value="Aa1!"
        onChange={() => {}}
        showStrengthFeedback
      />
    );

    expect(screen.getByText("passwordStrength.weak")).toBeTruthy();
    expect(container.querySelectorAll(".password-strength-meter-segment.is-empty").length).toBe(4);
    expect(container.querySelectorAll(".password-strength-meter-segment.is-weak").length).toBe(0);
  });

  it("only evaluates password strength when feedback is enabled", () => {
    const spy = vi.spyOn(passwordStrength, "evaluatePasswordStrength");

    const { rerender } = render(
      <PasswordInput
        id="password"
        value="password"
        onChange={() => {}}
      />
    );

    expect(spy).not.toHaveBeenCalled();

    rerender(
      <PasswordInput
        id="password"
        value="Password1!"
        onChange={() => {}}
      />
    );

    expect(spy).not.toHaveBeenCalled();

    rerender(
      <PasswordInput
        id="password"
        value="Password1!"
        onChange={() => {}}
        showStrengthFeedback
      />
    );

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("uses provided minLength for evaluator and requirement label", () => {
    const customMinLength = PASSWORD_MIN_LENGTH + 4;
    const spy = vi.spyOn(passwordStrength, "evaluatePasswordStrength");

    render(
      <PasswordInput
        id="password"
        value="Password1!"
        onChange={() => {}}
        minLength={customMinLength}
        showStrengthFeedback
      />
    );

    expect(spy).toHaveBeenCalledWith("Password1!", customMinLength);
    expect(screen.getByRole("listitem", { name: `passwordRuleMinLength:${customMinLength} - not met` })).toBeTruthy();

    spy.mockRestore();
  });
});
