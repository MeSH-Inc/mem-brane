import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { 'react-dom/client': 'react-dom/profiling' } },
  build: {
    outDir: 'dist-stress',
    rollupOptions: { input: fileURLToPath(new URL('./e2e/stress/index.html', import.meta.url)) },
  },
});
