import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";
import path from "node:path";

// Load apps/web/.env.local so the harness (clerkSetup, the Clerk backend client,
// Prisma) and the spawned dev servers all see the keys. Secrets are NEVER
// hardcoded — everything is read from env / .env.local.
dotenv.config({ path: path.resolve(__dirname, ".env.local") });

// @clerk/testing reads CLERK_PUBLISHABLE_KEY; our app uses the Next public name.
if (!process.env.CLERK_PUBLISHABLE_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
}

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Auth/session state is shared across steps in one spec — keep it serial.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // API (+ in-process worker) on :4000. Loads root .env itself.
      // --config.verify-deps-before-run=false: skip pnpm v11's auto pre-install
      // check, which fails on an unrelated ignored build script (unrs-resolver).
      command: "pnpm --config.verify-deps-before-run=false --filter @provable/api dev",
      url: "http://localhost:4000/health",
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Web on :3000. Next auto-loads apps/web/.env.local. Readiness probes
      // /sign-in (public, no API dependency) so boot doesn't wait on the API.
      command: "pnpm --config.verify-deps-before-run=false --filter @provable/web dev",
      url: "http://localhost:3000/sign-in",
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
