import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard front end lives in src/web/client and is served by Express from dist/client.
export default defineConfig({
  root: 'src/web/client',
  plugins: [react()],
  build: { outDir: '../../../dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    env: { DASHBOARD_PASSWORD: 'test', DATABASE_PATH: ':memory:' },
  },
});
