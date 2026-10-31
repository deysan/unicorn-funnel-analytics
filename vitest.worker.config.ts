import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
  test: {
    name: 'worker',
    include: ['tests/worker/**/*.test.ts'],
    isolate: true,
    retry: 0,
    passWithNoTests: false,
  },
});
