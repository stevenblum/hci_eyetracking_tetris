import { defineConfig, devices } from '@playwright/test';

const requestedBrowsers = (process.env.E2E_BROWSERS ?? 'chromium')
  .split(',')
  .map((browser) => browser.trim())
  .filter(Boolean);

const browserProjects = {
  chromium: {
    name: 'chromium',
    use: { ...devices['Desktop Chrome'] },
  },
  firefox: {
    name: 'firefox',
    use: { ...devices['Desktop Firefox'] },
  },
  webkit: {
    name: 'webkit',
    use: { ...devices['Desktop Safari'] },
  },
};

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  webServer: {
    command: 'npm run dev -- --host localhost',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: requestedBrowsers.map((browser) => browserProjects[browser] ?? browserProjects.chromium),
});
