import { config } from "dotenv";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createUnifiedApp } from "@everycal/runtime-core";
import bcrypt from "bcrypt";
import { getRequestListener } from "@hono/node-server";
import { initDatabase } from "./db.js";
import { DATABASE_PATH, UPLOAD_DIR } from "./lib/paths.js";
import { NodeStorage } from "./storage/node-storage.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });
config({ quiet: true });

const db = initDatabase(DATABASE_PATH);
const storage = new NodeStorage(db, UPLOAD_DIR);

const app = createUnifiedApp({
  storage,
  baseUrl: process.env.BASE_URL || "http://localhost:3000",
  sessionCookieName: "everycal_session",
  hashPassword: (password: string) => bcrypt.hash(password, 10),
  verifyPassword: (password: string, hash: string | null) => {
    if (!hash) return Promise.resolve(false);
    return bcrypt.compare(password, hash);
  },
});

const port = parseInt(process.env.PORT || "3000", 10);
console.log(`🗓️  EveryCal unified server starting on http://localhost:${port}`);

const listener = getRequestListener(app.fetch);
createServer((req, res) => {
  void listener(req, res);
}).listen(port);
