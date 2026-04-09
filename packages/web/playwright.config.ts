import { defineConfig, devices } from "@playwright/test";
import { cpus } from "node:os";

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? Math.min(cpus().length, 4) : undefined,
  reporter: [
    ["html", { open: "never", outputFolder: "playwright-report" }],
    ["list"],
  ],
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "Mobile Chrome",
      use: { ...devices["iPhone 14"] },
    },
  ],
  webServer: {
    command: "pnpm --filter @everycal/server dev",
    cwd: "../..",
    url: "http://localhost:3000/healthz",
    reuseExistingServer: !isCI,
    timeout: 120 * 1000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
