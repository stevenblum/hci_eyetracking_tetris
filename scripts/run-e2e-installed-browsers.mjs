import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const PLAYWRIGHT_BROWSER_PREFIXES = {
  chromium: ['chromium-', 'chromium_headless_shell-'],
  firefox: ['firefox-'],
  webkit: ['webkit-'],
};

const requestedBrowsers = process.env.E2E_BROWSERS?.split(',')
  .map((browser) => browser.trim())
  .filter(Boolean);
const browsers = requestedBrowsers?.length ? requestedBrowsers : detectInstalledBrowsers();

if (!browsers.length) {
  console.error('No installed Playwright browsers found. Run `npx playwright install chromium` first.');
  process.exit(1);
}

console.log(`Running Playwright e2e projects: ${browsers.join(', ')}`);
const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['playwright', 'test'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_BROWSERS: browsers.join(','),
    },
  },
);

process.exit(result.status ?? 1);

function detectInstalledBrowsers() {
  const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0'
    ? process.env.PLAYWRIGHT_BROWSERS_PATH
    : join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(browserPath)) {
    return [];
  }
  const entries = readdirSync(browserPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  return Object.entries(PLAYWRIGHT_BROWSER_PREFIXES)
    .filter(([_browser, prefixes]) => prefixes.some((prefix) => entries.some((entry) => entry.startsWith(prefix))))
    .map(([browser]) => browser);
}
