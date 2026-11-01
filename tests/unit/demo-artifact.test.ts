import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { demoConfig } from '../../scripts/demo-config';

it('real release CLI accepts a sealed artifact and rejects later bundle-byte changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'unicorn-artifact-test-'));
  const script = resolve('scripts/demo-artifact.ts');
  // No inherited credentials, Git configuration, hooks or real repository writes.
  const environment = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    DEMO_FREE_CONFIRMED: 'yes',
    COMMAND_HMAC_SECRET: Buffer.alloc(32, 1).toString('base64url'),
    IP_HMAC_SECRET: Buffer.alloc(32, 2).toString('base64url'),
    PARTNER_TOKENS: JSON.stringify({ 'demo-partner': Buffer.alloc(32, 3).toString('base64url') }),
    REPORT_USERNAME: 'synthetic', REPORT_PASSWORD: Buffer.alloc(32, 4).toString('base64url'),
  };
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, env: environment, encoding: 'utf8', timeout: 5000 });
    expect(result.status).toBe(0);
    return result.stdout.trim();
  };
  try {
    writeFileSync(join(directory, '.gitignore'), '.wrangler/\ndist-demo/\n');
    git('init', '--quiet'); git('add', '.gitignore');
    git('-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic artifact fixture');
    const sha = git('rev-parse', 'HEAD');
    const source = demoConfig({ name: 'unicorn-demo', databaseName: 'unicorn-demo', databaseId: '12345678-1234-4234-8234-123456789abc', origin: 'https://unicorn-demo.synthetic.workers.dev', mode: 'normal' });
    mkdirSync(join(directory, '.wrangler'));
    mkdirSync(join(directory, 'dist-demo/unicorn_demo'), { recursive: true });
    mkdirSync(join(directory, 'dist-demo/client'));
    writeFileSync(join(directory, '.wrangler/wrangler.demo.json'), JSON.stringify(source));
    writeFileSync(join(directory, 'dist-demo/unicorn_demo/wrangler.json'), JSON.stringify({
      ...source, main: 'index.js', no_bundle: true,
      assets: { ...source.assets, directory: '../client' },
      d1_databases: [{ ...source.d1_databases[0], migrations_dir: '../../migrations' }],
    }));
    const bundle = join(directory, 'dist-demo/unicorn_demo/index.js');
    writeFileSync(bundle, 'export default {};\n');
    writeFileSync(join(directory, 'dist-demo/client/index.html'), '<p>Synthetic artifact</p>');
    const cli = (command: string) => spawnSync(process.execPath, [script, command], {
      cwd: directory, env: { ...environment, RELEASE_SHA: sha }, encoding: 'utf8', timeout: 5000,
    });
    expect(cli('seal')).toMatchObject({ status: 0, stdout: 'demo_artifact_valid\n' });
    expect(cli('release')).toMatchObject({ status: 0, stdout: 'demo_artifact_valid\n' });
    writeFileSync(bundle, 'export default { changed: true };\n');
    expect(git('status', '--porcelain')).toBe('');
    expect(cli('release')).toMatchObject({ status: 1, stderr: 'demo_artifact_rejected\n' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
