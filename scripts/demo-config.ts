import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const demoConfigPath = '.wrangler/wrangler.demo.json';
export type DemoParameters = { name: string; databaseName: string; databaseId: string; origin: string; mode: string };
export const limiterBudgets = [
  ['QUIZ_IP_LIMITER', '1001', 300], ['QUIZ_USER_LIMITER', '1002', 120],
  ['BOOTSTRAP_LIMITER', '1003', 10], ['PARTNER_IP_LIMITER', '1004', 300],
  ['PARTNER_ID_LIMITER', '1005', 30], ['REPORT_IP_LIMITER', '1006', 300], ['REPORT_LIMITER', '1007', 30],
] as const;
export function demoConfig(p: DemoParameters) {
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(p.name) || !/^[a-z][a-z0-9-]{2,62}$/.test(p.databaseName)
    || /local|placeholder|example/.test(p.name + p.databaseName)) throw new Error('invalid_demo_name');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.databaseId)
    || p.databaseId.startsWith('00000000-')) throw new Error('invalid_demo_database');
  let origin: URL;
  try { origin = new URL(p.origin); } catch { throw new Error('invalid_demo_origin'); }
  if (origin.origin !== p.origin || origin.protocol !== 'https:' || origin.port || origin.username || origin.password
    || !new RegExp(`^${p.name}\\.[a-z0-9][a-z0-9-]*\\.workers\\.dev$`).test(origin.hostname)) throw new Error('invalid_demo_origin');
  if (!['normal', 'unavailable'].includes(p.mode)) throw new Error('invalid_demo_mode');
  return {
    name: p.name, main: '../src/server/index.ts', compatibility_date: '2026-10-30', compatibility_flags: ['nodejs_compat'],
    send_metrics: false, workers_dev: true, preview_urls: false, observability: { enabled: false },
    assets: { binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*', '/report', '/report/*'] },
    secrets: { required: ['COMMAND_HMAC_SECRET', 'IP_HMAC_SECRET', 'PARTNER_TOKENS', 'REPORT_USERNAME', 'REPORT_PASSWORD'] },
    triggers: { crons: ['* * * * *'] },
    vars: { MOCK_RECEIVER_MODE: p.mode, LOCAL_RUNTIME: 'false', ALLOWED_ORIGINS: p.origin },
    ratelimits: limiterBudgets.map(([name, namespace_id, limit]) => ({ name, namespace_id, simple: { limit, period: 60 } })),
    d1_databases: [{ binding: 'DB', database_name: p.databaseName, database_id: p.databaseId, migrations_dir: '../migrations', remote: false }],
  };
}
export function validateDemoConfig(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('invalid_demo_config');
  const c = value as ReturnType<typeof demoConfig>;
  try {
    const expected = demoConfig({ name: c.name, databaseName: c.d1_databases[0].database_name,
      databaseId: c.d1_databases[0].database_id, origin: c.vars.ALLOWED_ORIGINS, mode: c.vars.MOCK_RECEIVER_MODE });
    if (!isDeepStrictEqual(value, expected)) throw new Error();
    return expected;
  } catch { throw new Error('invalid_demo_config'); }
}
export function readDemoConfig() { return validateDemoConfig(JSON.parse(readFileSync(demoConfigPath, 'utf8'))); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'generate' && process.argv.length === 3) {
      const config = demoConfig({ name: process.env.DEMO_WORKER_NAME ?? '', databaseName: process.env.DEMO_DATABASE_NAME ?? '',
        databaseId: process.env.DEMO_DATABASE_ID ?? '', origin: process.env.DEMO_ORIGIN ?? '', mode: process.env.DEMO_RECEIVER_MODE ?? 'normal' });
      mkdirSync('.wrangler', { recursive: true }); writeFileSync(demoConfigPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    } else if (process.argv[2] === 'check' && process.argv.length === 3) readDemoConfig();
    else throw new Error('invalid_arguments');
    console.log('demo_config_valid');
  } catch { console.error('demo_config_rejected'); process.exitCode = 1; }
}
