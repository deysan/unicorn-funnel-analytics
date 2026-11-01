import { readFileSync } from 'node:fs';
import { demoConfigPath, readDemoConfig } from './scripts/demo-config';
import { unstable_readConfig } from 'wrangler';
import { receiverMode } from './src/server/delivery/contract';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { getOfferCatalog } from './src/server/offers/catalog';

export default defineConfig(async ({ mode, command }) => {
  const demo = mode === 'demo';
  if (demo && command !== 'build') throw new Error('demo_build_only');
  const configPath = demo ? demoConfigPath : 'wrangler.jsonc';
  if (demo) readDemoConfig();
  // Той самий валідатор, що й для нового серверного вибору.
  await getOfferCatalog();
  receiverMode(unstable_readConfig({ config: configPath }).vars.MOCK_RECEIVER_MODE);
  const https = demo ? undefined : { key: readFileSync('.wrangler/tls/key.pem'), cert: readFileSync('.wrangler/tls/cert.pem') };
  return {
    plugins: [react(), cloudflare({ configPath, persistState: { path: process.env.UNICORN_E2E === 'true' ? '.wrangler/e2e-state' : '.wrangler/state' } }),
      ...(demo ? [{ name: 'demo-no-preview-secrets', enforce: 'post' as const, generateBundle(_options: unknown, bundle: Record<string, unknown>) {
        // Cloudflare emits local preview secrets by default; a deployment artifact must never contain them.
        delete bundle['.dev.vars'];
      } }] : []),
    ],
    build: { outDir: demo ? 'dist-demo' : 'dist' },
    server: { https, port: 5173, strictPort: true },
    preview: { https, port: 4173, strictPort: true },
  };
});
