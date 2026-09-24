import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    allowedHosts: ['astra.dev.rubasace.dev'],
    proxy: { '/api': 'http://127.0.0.1:4749', '/healthz': 'http://127.0.0.1:4749' },
  },
});
