import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
// Each group starts its own isolated server. The real IP300/min budget is never raised.
const groups = args.length ? [args] : [
  ['--project=chromium', '--grep-invert=@partner|@report'],
  ['--project=firefox', '--project=webkit', '--project=mobile-chromium', '--project=mobile-webkit', '--grep-invert=@report'],
  ['--project=chromium', '--grep=@partner'],
  ['--project=chromium', '--grep=@report'],
  ['--project=firefox', '--project=webkit', '--project=mobile-chromium', '--project=mobile-webkit', '--grep=@report'],
];
for (const group of groups) {
  const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...group], { stdio: 'inherit', env: { ...process.env, UNICORN_SMOKE_GROUP: group.includes('--grep=@partner') ? 'partner-cli' : group.includes('--grep=@report') ? 'report-' + group[0].replace('--project=', '') : group[0].replace('--project=', '') } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
