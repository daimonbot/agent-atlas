import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()], server: { allowedHosts: ['atlas.dev.rubasace.dev'], proxy: { '/api': process.env.AGENT_ATLAS_DEV_API_ORIGIN || 'http://127.0.0.1:4747', '/healthz': process.env.AGENT_ATLAS_DEV_API_ORIGIN || 'http://127.0.0.1:4747' } }, build: { outDir: 'dist', emptyOutDir: true } });
