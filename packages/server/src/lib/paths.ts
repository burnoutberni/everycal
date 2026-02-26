import { resolve } from "node:path";

const repoRoot = resolve(process.cwd(), '../..');

export const DATABASE_PATH = process.env.DATABASE_PATH || resolve(repoRoot, "everycal.db");
export const UPLOAD_DIR = process.env.UPLOAD_DIR || resolve(repoRoot, "uploads");
export const OG_DIR = process.env.OG_DIR || resolve(repoRoot, "og-images");