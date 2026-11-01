import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/smoke',
  outputDir: './test-results/' + (process.env.UNICORN_SMOKE_GROUP ?? 'manual'),
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 45_000 },
  globalTimeout: 5 * 60_000,
  reporter: 'list',
  use: { baseURL: 'https://localhost:4173', ignoreHTTPSErrors: true },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', grep: /@critical/, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', grep: /@critical/, use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', grep: /@critical/, use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', grep: /@critical/, use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'https://localhost:4173',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
