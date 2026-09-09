import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: process.env.SIGNALK_BROWSER_URL ?? "http://127.0.0.1:3300",
    channel: "chromium",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : undefined,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "tablet", use: { viewport: { width: 820, height: 1180 } } },
  ],
});
