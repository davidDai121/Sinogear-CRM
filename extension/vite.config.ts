import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import path from 'node:path';
import manifest from './manifest.json';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const builtManifest = {
    ...manifest,
    oauth2: {
      ...manifest.oauth2,
      client_id: env.VITE_GOOGLE_CLIENT_ID || manifest.oauth2.client_id,
    },
  };

  return {
    plugins: [react(), crx({ manifest: builtManifest as any })],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      port: 5174,
      strictPort: true,
      hmr: { port: 5174 },
    },
    build: {
      target: 'esnext',
      sourcemap: true,
    },
  };
});
