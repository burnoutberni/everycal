import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  mkdirMock,
  statMock,
  readFileMock,
  renameMock,
  writeFileMock,
  unlinkMock,
  existsSyncMock,
  sharpToBufferMock,
} = vi.hoisted(() => ({
  mkdirMock: vi.fn(async () => undefined),
  statMock: vi.fn(async () => ({ mtimeMs: 0 })),
  readFileMock: vi.fn(async () => Buffer.from("")),
  renameMock: vi.fn(async () => undefined),
  writeFileMock: vi.fn(async () => undefined),
  unlinkMock: vi.fn(async () => undefined),
  existsSyncMock: vi.fn(() => true),
  sharpToBufferMock: vi.fn(async () => Buffer.from("processed")),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
  stat: statMock,
  readFile: readFileMock,
  rename: renameMock,
  writeFile: writeFileMock,
  unlink: unlinkMock,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    rotate: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    flatten: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: sharpToBufferMock,
  })),
}));

import { serveUploadsRoutes } from "../src/routes/serve-uploads.js";

function err(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function makeApp(uploadDir: string) {
  const app = new Hono();
  app.route("/uploads", serveUploadsRoutes({ uploadDir }));
  return app;
}

describe("serve uploads atomic derivative writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns bytes from outPath when rename loses race and removes temp file", async () => {
    const uploadDir = "/uploads";
    const sourcePath = "/uploads/race.png";
    const outPath = "/uploads/.derived/race.png.jpg";
    const winnerBytes = Buffer.from("winner");

    existsSyncMock.mockImplementation((path: string) => path === sourcePath);
    statMock.mockImplementation(async (path: string) => {
      if (path === sourcePath) {
        return { mtimeMs: 200 };
      }
      throw err("ENOENT");
    });
    readFileMock.mockImplementation(async (path: string) => {
      if (path === sourcePath) {
        return Buffer.from("source");
      }
      if (path === outPath) {
        return winnerBytes;
      }
      throw err("ENOENT");
    });
    renameMock.mockRejectedValue(err("EEXIST"));

    const app = makeApp(uploadDir);
    const res = await app.request("http://localhost/uploads/race.png");

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(winnerBytes);
    expect(writeFileMock).toHaveBeenCalledOnce();
    const tempPath = writeFileMock.mock.calls[0]?.[0] as string;
    expect(unlinkMock).toHaveBeenCalledWith(tempPath);
  });

  it("cleans temp file when rename fails and no winner exists", async () => {
    const uploadDir = "/uploads";
    const sourcePath = "/uploads/fail.png";

    existsSyncMock.mockImplementation((path: string) => path === sourcePath);
    statMock.mockImplementation(async (path: string) => {
      if (path === sourcePath) {
        return { mtimeMs: 200 };
      }
      throw err("ENOENT");
    });
    readFileMock.mockImplementation(async (path: string) => {
      if (path === sourcePath) {
        return Buffer.from("source");
      }
      throw err("ENOENT");
    });
    renameMock.mockRejectedValue(err("EINVAL"));

    const app = makeApp(uploadDir);
    const res = await app.request("http://localhost/uploads/fail.png");

    expect(res.status).toBe(404);
    expect(writeFileMock).toHaveBeenCalledOnce();
    const tempPath = writeFileMock.mock.calls[0]?.[0] as string;
    expect(unlinkMock).toHaveBeenCalledWith(tempPath);
  });
});
