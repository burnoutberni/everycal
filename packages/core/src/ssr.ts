export type SsrProfileData = {
  kind: "profile";
  username: string;
  user: Record<string, unknown> | null;
  profile: Record<string, unknown> | null;
  events: Record<string, unknown>[];
};

export type SsrEventData = {
  kind: "event";
  username: string;
  slug: string;
  user: Record<string, unknown> | null;
  event: Record<string, unknown> | null;
};

export type SsrInitialData = SsrProfileData | SsrEventData | null;
