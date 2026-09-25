import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser', timeout: 45000, expect: { timeout: 10000 },
  fullyParallel: true, workers: 3, reporter: 'list',
  use: { baseURL: process.env.BASE_URL || 'http://127.0.0.1:4173', viewport: { width: 1440, height: 1050 },
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  webServer: process.env.BASE_URL ? undefined : { command: 'npm run serve', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
});
