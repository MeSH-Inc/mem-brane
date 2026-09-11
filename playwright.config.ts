import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.browser.ts',
  testIgnore: '**/stress.browser.ts',
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    ...(['firefox', 'webkit'] as const).map((browserName) => ({
      name: browserName,
      use: { browserName },
      testMatch:
        /(?:canvas|canvas-loading|geometry|selection|presentation|input-modes)\.browser\.ts$/,
    })),
  ],
  use: { baseURL: 'http://127.0.0.1:4179', viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179/e2e/canvas.html',
  },
});
