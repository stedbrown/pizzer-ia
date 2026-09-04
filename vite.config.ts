import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// La dashboard è un'app a sé: sorgenti in web/, bundle in dist/web servito da Fastify.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } }
});
