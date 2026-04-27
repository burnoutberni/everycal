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
  const raw = args[tokenIndex];
  if (typeof raw !== "string") throw new Error("Token parameter must be a string");
  args[tokenIndex] = hashTokenSecret(raw);
  db.prepare(sql).run(...args);
}

export function findByTokenHash<T>(db: DB, sql: string, token: string): T | undefined {
  return db.prepare(sql).get(hashTokenSecret(token)) as T | undefined;
}
