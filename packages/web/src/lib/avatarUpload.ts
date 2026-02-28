export const MAX_AVATAR_UPLOAD_BYTES = 5 * 1024 * 1024;

export type AvatarUploadErrorKey =
  | "profile:avatarUploadInvalidType"
  | "profile:avatarUploadTooLarge";

export function validateAvatarUpload(file: File): AvatarUploadErrorKey | null {
  if (!file.type.startsWith("image/")) return "profile:avatarUploadInvalidType";
  if (file.size > MAX_AVATAR_UPLOAD_BYTES) return "profile:avatarUploadTooLarge";
  return null;
}
