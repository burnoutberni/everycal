import crypto from "node:crypto";
import type { DB } from "../db.js";

export function hashTokenSecret(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function storeHashedToken(
  db: DB,
  sql: string,
  params: readonly unknown[],
  tokenIndex: number,
): void {
  const args = [...params];
  if (!Number.isInteger(tokenIndex) || tokenIndex < 0 || tokenIndex >= args.length) {
    throw new Error(`tokenIndex ${tokenIndex} out of range for ${args.length} params`);
  }
  const raw = args[tokenIndex];
  if (typeof raw !== "string") {
    const receivedType = raw === null ? "null" : typeof raw;
    throw new Error(`Token parameter at index ${tokenIndex} must be a string (got ${receivedType})`);
  }
  args[tokenIndex] = hashTokenSecret(raw);
  db.prepare(sql).run(...args);
}

export function findByTokenHash<T>(db: DB, sql: string, token: string): T | undefined {
  return db.prepare(sql).get(hashTokenSecret(token)) as T | undefined;
}
