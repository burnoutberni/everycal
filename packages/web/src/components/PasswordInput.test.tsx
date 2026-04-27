// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PasswordInput } from "./PasswordInput";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
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

    const toggle = screen.getByRole("button", { name: "showPassword" });
    fireEvent.click(toggle);

    expect((screen.getByRole("button", { name: "hidePassword" }) as HTMLButtonElement).getAttribute("aria-pressed")).toBe("true");
    const visibleInput = document.getElementById("password") as HTMLInputElement;
    expect(visibleInput.type).toBe("text");
    expect(visibleInput.getAttribute("autocapitalize")).toBe("none");
    expect(visibleInput.getAttribute("autocorrect")).toBe("off");
    expect(visibleInput.getAttribute("spellcheck")).toBe("false");
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

    expect(screen.getByText("passwordStrengthLabel:")).toBeTruthy();
    expect(screen.getByText("passwordStrength.weak")).toBeTruthy();

    rerender(
      <PasswordInput
        id="password"
        value="Password1!"
        onChange={() => {}}
        showStrengthFeedback
      />
    );

    expect(screen.getByText("passwordStrength.strong")).toBeTruthy();
  });
});
