// The case walkthrough (`npm run walkthrough`): each case runs against its own local Worker under
// `wrangler dev`, so the run is serial and long. The installed Google Chrome drives the dashboard;
// Playwright downloads no browser. Frames are screenshots, so no video is recorded.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "../../test-results/walkthrough/playwright",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90 * 60_000,
  reporter: [["list"], ["json", { outputFile: "../../test-results/walkthrough/report.json" }]],
  use: {
    channel: "chrome",
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
});
