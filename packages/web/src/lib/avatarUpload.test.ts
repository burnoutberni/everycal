import { describe, expect, it } from "vitest";
import { MAX_AVATAR_UPLOAD_BYTES, validateAvatarUpload } from "./avatarUpload";

describe("validateAvatarUpload", () => {
  it("rejects non-image files", () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    expect(validateAvatarUpload(file)).toBe("profile:avatarUploadInvalidType");
  });

  it("rejects oversized image files", () => {
    const bytes = new Uint8Array(MAX_AVATAR_UPLOAD_BYTES + 1);
    const file = new File([bytes], "avatar.png", { type: "image/png" });
    expect(validateAvatarUpload(file)).toBe("profile:avatarUploadTooLarge");
  });

  it("accepts valid image files", () => {
    const file = new File([new Uint8Array(1024)], "avatar.png", { type: "image/png" });
    expect(validateAvatarUpload(file)).toBe(null);
  });
});
