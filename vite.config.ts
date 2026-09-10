import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pwa } from './scripts/pwa';
export default defineConfig({
  plugins: [react(), pwa()],
  server: { proxy: { '/api': 'http://127.0.0.1:3001' } },
});
