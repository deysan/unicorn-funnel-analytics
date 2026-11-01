import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { partnerEventSchema, type PartnerEventInput } from '../src/shared/partner.ts';

const directory = '.wrangler/partner-events';
function filePath(file: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json(?![\s\S])/.test(file)) throw new Error('invalid_file_name');
  return resolve(directory, file);
}
export async function prepare(file: string, input: unknown) {
  const parsed = partnerEventSchema.safeParse(input);
  if (!parsed.success) throw new Error('validation_failed');
  const payload = { ...parsed.data, occurred_at: new Date(parsed.data.occurred_at).toISOString() };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Exclusive create: an existing delivery file is never replaced by prepare.
  await writeFile(filePath(file), JSON.stringify(payload, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export function retryDelay(header: string | null, fallback: number, now: number, random: number): number {
  let seconds = fallback;
  if (header !== null && /^\d+(?:\.\d+)?$/.test(header)) {
    const value = Number(header); if (Number.isFinite(value)) seconds = value;
  } else if (header !== null) {
    const value = Date.parse(header); if (Number.isFinite(value) && value >= now) seconds = (value - now) / 1000;
  }
  return Math.ceil(seconds * 1000 * (1 + random * 0.1));
}
export async function send(file: string, target: string, token: string | undefined, dependencies = { fetch: globalThis.fetch, sleep: (ms: number) => sleep(ms), random: Math.random, now: Date.now }) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('tls_verification_required');
  if (!token || !/^[A-Za-z0-9_-]{43}(?![\s\S])/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) throw new Error('partner_token_required');
  let url: URL;
  try { url = new URL(target); } catch { throw new Error('invalid_target'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_target');
  const bytes = await readFile(filePath(file));
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('validation_failed'); }
  if (bytes.byteLength > 8192 || !partnerEventSchema.safeParse(parsed).success) throw new Error('validation_failed');
  const endpoint = new URL('/api/v1/partner/events', url);
  for (let retry = 0; retry <= 3; retry++) {
    let response: Response; let result: unknown;
    try {
      response = await dependencies.fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: bytes, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      result = await response.json();
    } catch { throw new Error('network_or_response_failure_repeat_same_file'); }
    if (response.status === 200 && result && typeof result === 'object' && 'status' in result && result.status === 'accepted') return;
    const error = result && typeof result === 'object' && 'error' in result ? result.error : undefined;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const fallback = response.status === 429 && code === 'rate_limited' ? 60 : response.status === 503 && code === 'rate_limit_unavailable' ? 30 : undefined;
    if (fallback !== undefined && retry < 3) {
      const delay = retryDelay(response.headers.get('retry-after'), fallback, dependencies.now(), dependencies.random());
      // Node timers cannot represent longer delays. Refuse rather than retry early.
      if (!Number.isSafeInteger(delay) || delay > 2_147_483_647) throw new Error('retry_later_same_file');
      await dependencies.sleep(delay); continue;
    }
    const publicCodes = ['postback_conflict', 'validation_failed', 'click_unavailable', 'unauthorized', 'payload_too_large', 'capacity_exceeded', 'rate_limited', 'rate_limit_unavailable', 'temporarily_unavailable'];
    throw new Error(typeof code === 'string' && publicCodes.includes(code) ? code : 'request_failed_repeat_same_file');
  }
}

async function main(args: string[]) {
  const [command, ...rest] = args; const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined || Object.hasOwn(values, rest[i].slice(2))) throw new Error('invalid_arguments');
    values[rest[i].slice(2)] = rest[i + 1];
  }
  const allowed = command === 'prepare' ? ['file', 'type', 'click', 'id', 'at', 'amount-minor', 'currency'] : command === 'send' ? ['file', 'target'] : [];
  if (!allowed.length || Object.keys(values).some((key) => !allowed.includes(key)) || !values.file) throw new Error('invalid_arguments');
  if (command === 'prepare') {
    if (values['amount-minor'] !== undefined && !/^[1-9][0-9]{0,6}$/.test(values['amount-minor'])) throw new Error('validation_failed');
    const input: PartnerEventInput | Record<string, unknown> = {
      event_type: values.type, click_id: values.click, partner_event_id: values.id ?? randomUUID(), occurred_at: values.at ?? new Date().toISOString(),
      ...(values['amount-minor'] === undefined ? {} : { amount_minor: Number(values['amount-minor']) }),
      ...(values.currency === undefined ? {} : { currency: values.currency }),
    };
    await prepare(values.file, input); process.stdout.write('prepared\n');
  } else {
    await send(values.file, values.target, process.env.PARTNER_TOKEN); process.stdout.write('accepted\n');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    // Never print filesystem paths, request payloads, URLs, network causes or secrets.
    const safe = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'command_failed';
    process.stderr.write(`${safe}\n`); process.exitCode = 1;
  });
}
