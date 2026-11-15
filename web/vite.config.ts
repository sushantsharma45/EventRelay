import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, '');
  const apiOrigin = 'http://127.0.0.1:' + (env.PORT || '4000');

  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/v1': apiOrigin,
        '/health': apiOrigin,
      },
    },
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
    },
  };
});
