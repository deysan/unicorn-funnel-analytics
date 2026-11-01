import { importFingerprintKey } from '../storage/command-fingerprint';
import { PROFILE_TTL_MS } from '../storage/profile';
import { GuardedBatch, classifyGuard } from '../storage/transaction-guards';
import { readCapacitySnapshot, reserveCapacity, persistCapacityPause } from '../storage/capacity';
export type QuizBindings = Pick<Env, 'DB' | 'LOCAL_RUNTIME' | 'ALLOWED_ORIGINS' | 'QUIZ_IP_LIMITER' | 'QUIZ_USER_LIMITER' | 'BOOTSTRAP_LIMITER'> & Partial<Pick<Env, 'COMMAND_HMAC_SECRET' | 'IP_HMAC_SECRET'>>;
export class HttpFailure extends Error {
  constructor(public code: string, public status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 413 | 415 | 429 | 503, public retryable = false, public retryAfter?: number) { super(code); }
}
export const cookieName = '__Host-unicorn';
export const hex = (value: ArrayBuffer) => Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, '0')).join('');
export function decodeSecret(value: string | undefined): Uint8Array<ArrayBuffer> {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('secret_unavailable');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='), (c) => c.charCodeAt(0));
  if (encodeSecret(bytes) !== value) throw new Error('secret_invalid');
  return bytes;
}
export function encodeSecret(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
export async function keyring(env: QuizBindings) { return { currentVersion: 'v1', keys: new Map([['v1', await importFingerprintKey(decodeSecret(env.COMMAND_HMAC_SECRET))]]) }; }
export async function identity(request: Request, db: D1Database) {
  const parts = (request.headers.get('cookie') ?? '').split(';').map((s) => s.trim()).filter((s) => s.startsWith(cookieName + '='));
  if (!parts.length) return { status: 'missing' } as const;
  if (parts.length !== 1) return { status: 'invalid' } as const;
  const token = parts[0].slice(cookieName.length + 1);
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = decodeSecret(token); } catch { return { status: 'invalid' } as const; }
  const hash = hex(await crypto.subtle.digest('SHA-256', bytes));
  const row = await db.prepare(`SELECT user_id, last_active_at FROM users WHERE access_secret_hash = ?
    AND revoked_at IS NULL AND expired_at IS NULL AND last_active_at > ?`).bind(hash, Date.now() - PROFILE_TTL_MS).first<{user_id: string; last_active_at: number}>();
  return row ? { status: 'ready', userId: row.user_id, hash, token, lastActiveAt: row.last_active_at } as const : { status: 'invalid' } as const;
}
export function cookie(token: string, activity: number) {
  const expires = activity + PROFILE_TTL_MS;
  return `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((expires - Date.now()) / 1000))}; Expires=${new Date(expires).toUTCString()}`;
}
export async function createIdentity(db: D1Database) {
  const token = encodeSecret(crypto.getRandomValues(new Uint8Array(32)));
  const hash = hex(await crypto.subtle.digest('SHA-256', decodeSecret(token)));
  const userId = crypto.randomUUID(); const now = Date.now();
  const snapshot = await readCapacitySnapshot(db, { profiles: 1 });
  const batch = new GuardedBatch(db); reserveCapacity(batch, { profiles: 1 }, snapshot);
  batch.effect({ changes: 1, statement: db.prepare('INSERT INTO users (user_id, created_at, last_active_at, access_secret_hash) VALUES (?, ?, ?, ?)').bind(userId, now, now, hash) });
  try { await db.batch(batch.finish()); } catch (e) {
    if (classifyGuard(e) === 'capacity_profiles') { await persistCapacityPause(db, 'profiles', snapshot.profiles!); throw new HttpFailure('capacity_exceeded', 503, true); }
    throw e;
  }
  return { userId, token, now };
}
type LocalBindings = Pick<QuizBindings, 'LOCAL_RUNTIME' | 'IP_HMAC_SECRET'>;
export function localRequest(request: Request, env: LocalBindings) {
  const hostname = new URL(request.url).hostname;
  if (env.LOCAL_RUNTIME !== 'true' || !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) throw new HttpFailure('rate_limit_unavailable', 503, true, 30);
}
export async function ipKey(request: Request, env: LocalBindings) {
  // This build is explicitly local. Forwarded headers never authorize an address.
  localRequest(request, env);
  try {
  const key = await importFingerprintKey(decodeSecret(env.IP_HMAC_SECRET));
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('127.0.0.1')));
  } catch { throw new HttpFailure('rate_limit_unavailable', 503, true, 30); }
}
export async function limit(binding: RateLimit | undefined, key: string, budget: { remaining: number }) {
  const remaining = budget.remaining;
  const started = Date.now();
  if (!binding || remaining <= 0) throw new HttpFailure('rate_limit_unavailable', 503, true, 30);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([binding.limit({ key }), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new HttpFailure('rate_limit_unavailable', 503, true, 30)), remaining);
    })]);
    if (!result.success) throw new HttpFailure('rate_limited', 429, true, 60);
  } catch (error) {
    if (error instanceof HttpFailure) throw error;
    throw new HttpFailure('rate_limit_unavailable', 503, true, 30);
  } finally { budget.remaining -= Date.now() - started; if (timer !== undefined) clearTimeout(timer); }
}
export async function body(request: Request, env: QuizBindings): Promise<Record<string, unknown>> {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null' || !(env.ALLOWED_ORIGINS ?? '').split(',').includes(origin)) throw new HttpFailure('request_origin_rejected', 403);
  return boundedJson(request);
}
export async function boundedJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.has('content-encoding') || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) throw new HttpFailure('unsupported_media_type', 415);
  const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  if (!reader) throw new HttpFailure('validation_failed', 400);
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
      if (size > 8192) { void reader.cancel(); throw new HttpFailure('payload_too_large', 413); } chunks.push(part.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (error) { if (error instanceof HttpFailure) throw error; throw new HttpFailure('validation_failed', 400); }
}
