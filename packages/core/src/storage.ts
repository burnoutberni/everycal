export type RuntimeTarget = "node" | "cloudflare";

export interface SessionRecord {
  token: string;
  accountId: string;
  expiresAt: string;
}

export interface AccountRecord {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface EventRecord {
  id: string;
  accountId: string;
  title: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
  visibility: "public" | "unlisted" | "followers_only" | "private";
}

export interface UploadBlob {
  key: string;
  contentType: string;
  body: ArrayBuffer;
}

export interface EveryCalStorage {
  runtime: RuntimeTarget;
  getSession(token: string): Promise<SessionRecord | null>;
  getAccountById(id: string): Promise<AccountRecord | null>;
  listPublicEventsByUsername(username: string, limit?: number): Promise<EventRecord[]>;
  upsertUpload(blob: UploadBlob): Promise<string>;
}
