import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/stress.browser.ts',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  projects: (['chromium', 'firefox', 'webkit'] as const).map((browserName) => ({
    name: browserName,
    use: { browserName },
  })),
  use: { baseURL: 'http://127.0.0.1:4180', viewport: { width: 1440, height: 1000 } },
  reporter: [['list'], ['./scripts/stress-reporter.ts']],
  outputDir: 'test-results/stress',
  webServer: {
    command:
      'npx vite preview --config vite.stress.config.ts --host 127.0.0.1 --port 4180 --strictPort',
    url: 'http://127.0.0.1:4180/e2e/stress/index.html',
  },
});
