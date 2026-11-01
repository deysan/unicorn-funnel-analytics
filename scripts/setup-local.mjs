import { newHistorySql } from './report-history.ts';
import { randomBytes } from 'node:crypto';
import { readFile, appendFile, chmod, mkdir, writeFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
let existing = await readFile('.dev.vars', 'utf8').catch((e) => { if (e.code === 'ENOENT') return ''; throw e; });
for (const key of ['COMMAND_HMAC_SECRET', 'IP_HMAC_SECRET']) {
  if (!new RegExp(`^${key}=`, 'm').test(existing)) {
    const line = `\n${key}=${randomBytes(32).toString('base64url')}\n`;
    await appendFile('.dev.vars', line, { mode: 0o600 }); existing += line;
  }
}
if (!/^PARTNER_TOKENS=/m.test(existing)) {
  const value = JSON.stringify({ 'demo-partner': randomBytes(32).toString('base64url') });
  await appendFile('.dev.vars', `\nPARTNER_TOKENS='${value}'\n`, { mode: 0o600 });
}
for (const [key, value] of [['REPORT_USERNAME', 'report-' + randomBytes(6).toString('hex')], ['REPORT_PASSWORD', randomBytes(32).toString('base64url')]]) {
  if (!new RegExp(`^${key}=`, 'm').test(existing)) await appendFile('.dev.vars', `\n${key}=${value}\n`, { mode: 0o600 });
}
await chmod('.dev.vars', 0o600);
await mkdir('.wrangler/tls', { recursive: true });
try { await access('.wrangler/tls/cert.pem'); await access('.wrangler/tls/key.pem'); }
catch {
  await writeFile('.wrangler/tls/openssl.cnf', '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365', '-keyout', '.wrangler/tls/key.pem', '-out', '.wrangler/tls/cert.pem', '-config', '.wrangler/tls/openssl.cnf'], { stdio: 'pipe' });
  if (certificate.status !== 0) throw new Error('Local TLS setup requires openssl');
  await chmod('.wrangler/tls/key.pem', 0o600);
}
if (process.argv.includes('--secrets-only')) process.exit(0);
const persistence = process.env.UNICORN_E2E === 'true' ? '.wrangler/e2e-state' : '.wrangler/state';
// Absence of D1 storage before migration is the proof of a new local history.
let newPersistence = false;
try { await access(persistence + '/v3/d1'); } catch (e) { if (e.code === 'ENOENT') newPersistence = true; else throw e; }
const result = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'unicorn-local', '--local', '--persist-to', persistence], { stdio: 'inherit', env: process.env });
if (result.status !== 0) process.exit(result.status ?? 1);

if (newPersistence) {
  const sql = newHistorySql(Math.floor(Date.now() / 86400000) * 86400000);
  const initialized = spawnSync('npx', ['wrangler', 'd1', 'execute', 'unicorn-local', '--local', '--persist-to', persistence, '--command', sql], { stdio: 'inherit', env: process.env });
  if (initialized.status !== 0) process.exit(initialized.status ?? 1);
}
