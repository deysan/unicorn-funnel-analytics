import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readDemoConfig } from './demo-config.ts';
const root = 'dist-demo';
const manifest = root + '/release-evidence.json';
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(directory + '/' + entry.name) : [directory + '/' + entry.name]).filter((path) => path !== manifest).sort();
}
export function inspectArtifact() {
  const source = readDemoConfig();
  const path = `${root}/${source.name.replaceAll('-', '_')}/wrangler.json`;
  const built = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const equal = (a: unknown, b: unknown) => { if (!isDeepStrictEqual(a, b)) throw new Error('demo_artifact_rejected'); };
  for (const field of ['name', 'vars', 'ratelimits', 'triggers', 'secrets', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'preview_urls', 'observability'] as const) equal(built[field], source[field]);
  equal(built.main, 'index.js'); equal(built.no_bundle, true);
  equal(built.assets, { ...source.assets, directory: '../client' });
  equal(built.d1_databases, [{ ...source.d1_databases[0], migrations_dir: '../../migrations' }]);
  for (const field of ['kv_namespaces','r2_buckets','services','workflows','queues','durable_objects','send_email','routes','unsafe','limits']) {
    const value = built[field];
    if (value !== undefined && JSON.stringify(value) !== '[]' && JSON.stringify(value) !== '{"bindings":[]}' && JSON.stringify(value) !== '{"producers":[],"consumers":[]}') throw new Error('demo_artifact_rejected');
  }
  const knownSecrets: string[] = [];
  const add = (values: Record<string,string|undefined>) => {
    for (const name of source.secrets.required) {
      const value = values[name]; if (!value) continue;
      if (name === 'PARTNER_TOKENS') { const tokens: unknown = JSON.parse(value); if (tokens && typeof tokens === 'object') knownSecrets.push(...Object.values(tokens).filter((v): v is string => typeof v === 'string')); }
      else if (name !== 'REPORT_USERNAME') knownSecrets.push(value);
    }
  };
  add(process.env);
  try { add(parseEnv(readFileSync('.dev.vars', 'utf8'))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const hashes = files(root).map((file) => {
    const bytes = readFileSync(file);
    if (/\.dev\.vars|\.env(?:\.|$)/.test(file) || knownSecrets.some((secret) => bytes.includes(Buffer.from(secret)))) throw new Error('demo_artifact_secret_detected');
    return [file, createHash('sha256').update(bytes).digest('hex')];
  });
  return { sha: git('rev-parse', 'HEAD'), clean: git('status', '--porcelain').length === 0, hashes };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const evidence = inspectArtifact();
    if (process.argv[2] === 'seal' && process.argv.length === 3) writeFileSync(manifest, JSON.stringify(evidence, null, 2) + '\n');
    else if (process.argv[2] === 'release' && process.argv.length === 3) {
      if (!evidence.clean || evidence.sha !== process.env.RELEASE_SHA || process.env.DEMO_FREE_CONFIRMED !== 'yes'
        || !isDeepStrictEqual(evidence, JSON.parse(readFileSync(manifest, 'utf8')))) throw new Error('release_gate_failed');
    } else throw new Error('invalid_arguments');
    console.log('demo_artifact_valid');
  } catch { console.error('demo_artifact_rejected'); process.exitCode = 1; }
}
