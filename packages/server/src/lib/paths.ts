import { resolve } from "node:path";

const repoRoot = resolve(process.cwd(), '../..');

export function getDatabasePath(): string {
  return process.env.DATABASE_PATH || resolve(repoRoot, "everycal.db");
}

export function getUploadDir(): string {
  return process.env.UPLOAD_DIR || resolve(repoRoot, "uploads");
}

export function getOgDir(): string {
  return process.env.OG_DIR || resolve(repoRoot, "og-images");
}
