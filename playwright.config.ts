import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.browser.ts',
  use: { baseURL: 'http://127.0.0.1:4179', viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179/e2e/canvas.html',
  },
});
