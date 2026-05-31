#!/usr/bin/env node
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const task = process.argv[2] || "build";
const packageRoot = new URL("..", import.meta.url);

if (process.platform !== "darwin") {
  console.log(`@everycal/macos ${task}: skipped because SwiftUI/AppKit builds require macOS (current platform: ${process.platform}).`);
  process.exit(0);
}

const commands = {
  build: ["swift", ["build", "-c", "release"]],
  bundle: ["swift", ["build", "-c", "release"]],
  dev: ["swift", ["run", "EveryCalMac"]],
  lint: ["swift", ["build"]],
  test: ["swift", ["test"]],
};

const [command, args] = commands[task] || commands.build;
const result = spawnSync(command, args, { stdio: "inherit", cwd: packageRoot });
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

if (task === "build" || task === "bundle") {
  const root = dirname(fileURLToPath(import.meta.url));
  const packageDir = join(root, "..");
  const appDir = join(packageDir, ".build", "EveryCal.app");
  const contentsDir = join(appDir, "Contents");
  const macOSDir = join(contentsDir, "MacOS");
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(macOSDir, { recursive: true });
  copyFileSync(join(packageDir, "AppBundle", "Info.plist"), join(contentsDir, "Info.plist"));
  const releaseExecutable = join(packageDir, ".build", "release", "EveryCalMac");
  if (!existsSync(releaseExecutable)) {
    throw new Error(`Swift build succeeded but ${releaseExecutable} was not produced.`);
  }
  const bundledExecutable = join(macOSDir, "EveryCalMac");
  copyFileSync(releaseExecutable, bundledExecutable);
  chmodSync(bundledExecutable, 0o755);
  const resourcesDir = join(packageDir, "AppBundle", "Resources");
  if (existsSync(resourcesDir)) cpSync(resourcesDir, join(contentsDir, "Resources"), { recursive: true });
  console.log(`Created ${appDir}`);
}
