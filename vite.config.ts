import { readFileSync } from 'node:fs';
import { unstable_readConfig } from 'wrangler';
import { receiverMode } from './src/server/delivery/contract';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { getOfferCatalog } from './src/server/offers/catalog';

export default defineConfig(async () => {
  // Той самий валідатор, що й для нового серверного вибору.
  await getOfferCatalog();
  receiverMode(unstable_readConfig({ config: 'wrangler.jsonc' }).vars.MOCK_RECEIVER_MODE);
  const https = { key: readFileSync('.wrangler/tls/key.pem'), cert: readFileSync('.wrangler/tls/cert.pem') };
  return {
    plugins: [react(), cloudflare({ persistState: { path: process.env.UNICORN_E2E === 'true' ? '.wrangler/e2e-state' : '.wrangler/state' } })],
    server: { https, port: 5173, strictPort: true },
    preview: { https, port: 4173, strictPort: true },
  };
});
