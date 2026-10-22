import { defineConfig, devices } from '@playwright/test';

const externalBaseUrl = process.env.E2E_BASE_URL;
const localBaseUrl = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // Retries hide flake instead of measuring it, and the launch budget needs the
  // observed rate. Every failure is a failure, including in CI.
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/playwright',
  reporter: process.env.CI ? [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]] : 'line',
  use: {
    baseURL: externalBaseUrl ?? localBaseUrl,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  // A deployed candidate already serves itself; only the local gate builds and
  // starts the Worker.
  ...(externalBaseUrl
    ? {}
    : {
        webServer: {
          command: 'pnpm exec vite preview --host 127.0.0.1 --port 4173',
          url: `${localBaseUrl}/api/health`,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      }),
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
