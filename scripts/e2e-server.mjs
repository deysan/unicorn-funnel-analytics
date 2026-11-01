import { rm } from 'node:fs/promises';
import { spawnSync, spawn } from 'node:child_process';
// Only this dedicated test persistence is removed. Dev storage is never touched.
await rm('.wrangler/e2e-state', { recursive: true, force: true });
const env = { ...process.env, UNICORN_E2E: 'true' };
const setup = spawnSync(process.execPath, ['scripts/setup-local.mjs'], { stdio: 'inherit', env });
if (setup.status !== 0) process.exit(setup.status ?? 1);
const seed = spawnSync(process.execPath, ['scripts/seed-e2e.mjs'], { stdio: 'inherit', env });
if (seed.status !== 0) process.exit(seed.status ?? 1);
const server = spawn('npx', ['vite', 'preview', '--host', 'localhost'], { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
