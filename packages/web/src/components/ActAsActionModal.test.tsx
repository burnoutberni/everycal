// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const tMock = (key: string) => key;
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: tMock }),
}));

const mockUser = { id: "owner", username: "owner", displayName: "Owner" };
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: mockUser }),
}));

vi.mock("../lib/api", () => ({
  identities: {
    list: vi.fn(),
  },
}));

import { ActAsActionModal } from "./ActAsActionModal";
import { identities as identitiesApi } from "../lib/api";

describe("ActAsActionModal accessibility", () => {
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockReset();
    vi.mocked(identitiesApi.list).mockResolvedValue({
      identities: [{ id: "identity1", username: "collective", displayName: "Collective" }] as any,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("closes modal on Escape when combobox is closed", async () => {
    render(
      <ActAsActionModal
        open
        onClose={onClose}
        actionKind="follow"
        loadState={async () => ({ activeAccountIds: [] })}
        apply={async () => ({ ok: true, added: 0, removed: 0, unchanged: 0, failed: 0, results: [] })}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("actAsHint")).toBeTruthy();
    });

    const input = await screen.findByPlaceholderText("addAccountPlaceholder") as HTMLInputElement;
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Shift+Tab focus within modal", async () => {
    render(
      <ActAsActionModal
        open
        onClose={onClose}
        actionKind="follow"
        loadState={async () => ({ activeAccountIds: [] })}
        apply={async () => ({ ok: true, added: 0, removed: 0, unchanged: 0, failed: 0, results: [] })}
      />
    );

    const input = await screen.findByPlaceholderText("addAccountPlaceholder") as HTMLInputElement;

    const closeX = screen.getByLabelText("close") as HTMLButtonElement;
    const footerCloseButton = screen.getAllByRole("button", { name: "close" })[1] as HTMLButtonElement;

    closeX.focus();
    expect(document.activeElement).toBe(closeX);
    fireEvent.keyDown(closeX, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(footerCloseButton);

    input.focus();
    expect(document.activeElement).toBe(input);
    footerCloseButton.focus();
    expect(document.activeElement).toBe(footerCloseButton);
  });

  it("supports keyboard option selection and chip removal", async () => {
    render(
      <ActAsActionModal
        open
        onClose={onClose}
        actionKind="follow"
        loadState={async () => ({ activeAccountIds: [] })}
        apply={async () => ({ ok: true, added: 0, removed: 0, unchanged: 0, failed: 0, results: [] })}
      />
    );

    const input = await screen.findByPlaceholderText("addAccountPlaceholder") as HTMLInputElement;
    input.focus();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("@collective")).toBeTruthy();
    expect(screen.getByLabelText("remove @collective")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.queryByLabelText("remove @collective")).toBeNull();
  });

  it("closes only dropdown on Escape from combobox", async () => {
    render(
      <ActAsActionModal
        open
        onClose={onClose}
        actionKind="follow"
        loadState={async () => ({ activeAccountIds: [] })}
        apply={async () => ({ ok: true, added: 0, removed: 0, unchanged: 0, failed: 0, results: [] })}
      />
    );

    const input = await screen.findByPlaceholderText("addAccountPlaceholder") as HTMLInputElement;
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });

    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeTruthy();
    });

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(0);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
