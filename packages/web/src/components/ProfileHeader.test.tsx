// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProfileHeader } from "./ProfileHeader";
import type { User } from "../lib/api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "showMoreBio") return "Show more";
      if (key === "showLessBio") return "Show less";
      if (key === "editProfile") return "Edit profile";
      if (key === "settings:displayName") return "Display name";
      return key;
    },
  }),
}));

describe("ProfileHeader", () => {
  const profile: User = {
    id: "user-1",
    username: "alice",
    displayName: "Alice",
    bio: `<p>${"Long bio ".repeat(40)}</p>`,
    followersCount: 1,
    followingCount: 2,
  };

  it("collapses bio by default and toggles expanded state", () => {
    render(
      <ProfileHeader
        profile={profile}
        currentUser={null}
        isOwn={false}
        isRemote={false}
      />
    );

    const bio = document.querySelector(".profile-bio") as HTMLElement;
    expect(bio.className.includes("profile-bio-collapsed")).toBe(true);

    const toggle = screen.getByRole("button", { name: "Show more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("shows edit button when profile is editable", () => {
    render(
      <ProfileHeader
        profile={profile}
        currentUser={profile}
        isOwn={true}
        isRemote={false}
        canEditProfile
      />
    );

    expect(screen.getByRole("button", { name: "Edit profile" })).toBeTruthy();
  });

  it("provides an accessible label for inline display name input", () => {
    render(
      <ProfileHeader
        profile={profile}
        currentUser={profile}
        isOwn={true}
        isRemote={false}
        editingProfile
        inlineDraft={{
          displayName: "Alice",
          bio: "",
          website: "",
          avatarUrl: "",
        }}
      />
    );

    expect(screen.getByRole("textbox", { name: "Display name" })).toBeTruthy();
  });

  it("preserves newlines in plain-text bios", () => {
    render(
      <ProfileHeader
        profile={{ ...profile, bio: "First line\nSecond line" }}
        currentUser={null}
        isOwn={false}
        isRemote={false}
      />
    );

    expect(document.querySelector(".profile-bio-plain")).toBeTruthy();
  });
});
