import { defineConfig, devices } from '@playwright/test';

// Chromium is preinstalled at /opt/pw-browsers (do NOT run `playwright install`).
const executablePath = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:8099',
    locale: 'nl-NL',
    launchOptions: { executablePath },
  },
  projects: [{ name: 'mobile', use: { ...devices['Pixel 7'], launchOptions: { executablePath } } }],
  webServer: {
    command: 'node scripts/serve-dist.mjs 8099',
    url: 'http://localhost:8099',
    reuseExistingServer: true,
  },
});
