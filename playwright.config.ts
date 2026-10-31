import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/smoke',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  globalTimeout: 5 * 60_000,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4173' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', grep: /@critical/, use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', grep: /@critical/, use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chromium', grep: /@critical/, use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', grep: /@critical/, use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
