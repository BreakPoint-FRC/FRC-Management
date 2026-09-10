import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  use: { baseURL: "http://localhost:3100", browserName: "chromium", timezoneId: "Europe/Istanbul", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec next dev -p 3100",
    url: "http://localhost:3100/login",
    reuseExistingServer: !process.env.CI,
    env: { NEXT_PUBLIC_API_URL: "http://localhost:4100" },
    timeout: 120000,
  },
});
