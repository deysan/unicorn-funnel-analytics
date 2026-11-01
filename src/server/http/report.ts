import { Hono } from 'hono';
import { parseReportQuery } from '../../shared/report';
import { readFilters, readFunnel, readStatus } from '../report/read';
import { decodeSecret, HttpFailure, ipKey, limit } from './security';
export type ReportBindings = Pick<Env, 'DB' | 'LOCAL_RUNTIME' | 'REPORT_IP_LIMITER' | 'REPORT_LIMITER' | 'ASSETS' | 'MOCK_RECEIVER_MODE'>
  & Partial<Pick<Env, 'IP_HMAC_SECRET' | 'REPORT_USERNAME' | 'REPORT_PASSWORD'>>;
export function reportIdentity(request: Request, env: ReportBindings) {
  const username = env.REPORT_USERNAME;
  let expectedPassword: Uint8Array<ArrayBuffer>;
  try {
    if (!username || !/^[a-zA-Z0-9_-]{1,64}(?![\s\S])/.test(username)) throw new Error();
    expectedPassword = decodeSecret(env.REPORT_PASSWORD);
  } catch { throw new HttpFailure('temporarily_unavailable', 503, true); }
  try {
    if (new URL(request.url).protocol !== 'https:') throw new Error();
    const match = /^Basic ([A-Za-z0-9+/]+={0,2})(?![\s\S])/i.exec(request.headers.get('authorization') ?? '');
    if (!match) throw new Error();
    const decoded = atob(match[1]);
    const index = decoded.indexOf(':');
    const suppliedName = new TextEncoder().encode(decoded.slice(0, index));
    const expectedName = new TextEncoder().encode(username);
    const suppliedPassword = decodeSecret(decoded.slice(index + 1));
    if (index < 0 || suppliedName.length !== expectedName.length || !crypto.subtle.timingSafeEqual(suppliedName, expectedName)
      || !crypto.subtle.timingSafeEqual(suppliedPassword, expectedPassword)) throw new Error();
  } catch { throw new HttpFailure('unauthorized', 401); }
}
export const report = new Hono<{ Bindings: ReportBindings }>();
report.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  try {
    const budget = { remaining: 1000 };
    await limit(c.env.REPORT_IP_LIMITER, await ipKey(c.req.raw, c.env), budget);
    reportIdentity(c.req.raw, c.env);
    await limit(c.env.REPORT_LIMITER, 'report', budget);
    await next();
  } catch (error) {
    const e = error instanceof HttpFailure ? error : new HttpFailure('temporarily_unavailable', 503, true);
    if (e.retryAfter) c.header('Retry-After', String(e.retryAfter));
    if (e.status === 401) c.header('WWW-Authenticate', 'Basic realm="Unicorn report", charset="UTF-8"');
    return c.json({ error: { code: e.code, message: 'Звіт недоступний. Перевірте доступ і фільтри або повторіть пізніше.', retryable: e.retryable } }, e.status);
  }
});
// Hono catches handler errors before outer middleware; keep error mapping inside handler middleware.
report.onError((error, c) => {
  const e = error instanceof HttpFailure ? error : new HttpFailure('temporarily_unavailable', 503, true);
  c.header('Cache-Control', 'no-store');
  return c.json({ error: { code: e.code, message: 'Звіт недоступний. Перевірте фільтри або повторіть пізніше.', retryable: e.retryable } }, e.status);
});
report.get('/api/v1/report/funnel', async (c) => {
  let query;
  try { query = parseReportQuery(new URL(c.req.url).searchParams); } catch { throw new HttpFailure('validation_failed', 400); }
  return c.json(await readFunnel(c.env.DB, query));
});
report.get('/api/v1/report/status', async (c) => {
  if (new URL(c.req.url).searchParams.size) throw new HttpFailure('validation_failed', 400);
  return c.json(await readStatus(c.env.DB, c.env.MOCK_RECEIVER_MODE));
});
report.get('/api/v1/report/filters', async (c) => {
  if (new URL(c.req.url).searchParams.size) throw new HttpFailure('validation_failed', 400);
  return c.json(await readFilters(c.env.DB));
});
for (const path of ['/report', '/report/*']) report.get(path, async (c) => {
  const response = await c.env.ASSETS.fetch(c.req.raw);
  const headers = new Headers(response.headers); headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
});
