import { quizResultResponse } from '../../src/server/http/quiz-result';
import type { CommandResult } from '../../src/server/storage/command-results';
import { Hono } from 'hono';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { quiz } from '../../src/server/http/quiz';
import { encodeSecret, limit, type QuizBindings } from '../../src/server/http/security';
import { freshBusinessDb, db, id } from './helpers/business-db';
const secret = encodeSecret(new Uint8Array(32).fill(9));
const allow = { limit: async () => ({ success: true }) } as RateLimit;
const bindings: QuizBindings = { ...env, COMMAND_HMAC_SECRET: secret, IP_HMAC_SECRET: secret,
  QUIZ_IP_LIMITER: allow, QUIZ_USER_LIMITER: allow, BOOTSTRAP_LIMITER: allow };
const request = (path: string, options: { payload?: unknown; cookie?: string; user?: string; headers?: Record<string, string>; raw?: string; env?: QuizBindings } = {}) => quiz.request('http://localhost:5173' + path, {
  method: options.payload === undefined && options.raw === undefined ? 'GET' : 'POST',
  headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json', ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.user ? { 'X-Expected-User-ID': options.user } : {}), ...options.headers },
  body: options.raw ?? (options.payload === undefined ? undefined : JSON.stringify(options.payload)),
}, options.env ?? bindings);
async function bootstrap() { const r = await request('/identity', { payload: {} }); expect(r.status).toBe(201); return { cookie: r.headers.get('set-cookie')!.split(';')[0], user: (await r.json() as {user_id:string}).user_id }; }
async function businessSnapshot() {
  const tables = ['users', 'user_offer_leads', 'events', 'event_delivery', 'clicks', 'request_results', 'capacity_control', 'system_control', 'transaction_assertions'];
  return Promise.all(tables.map(async (table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results));
}
beforeEach(freshBusinessDb);
describe('quiz HTTP identity and protocol', () => {
  it('GET missing does not allocate; bootstrap hashes random bytes and ready does not renew', async () => {
    expect(await (await request('/context?preland_id=demo')).json()).toMatchObject({ identity_status: 'missing' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(0);
    const auth = await bootstrap();
    expect(auth.cookie).toMatch(/^__Host-unicorn=[A-Za-z0-9_-]{43}$/);
    const ready = await request('/identity', { ...auth, payload: {} }); expect(ready.status).toBe(200); expect(ready.headers.has('set-cookie')).toBe(false);
    expect(await db.prepare("SELECT used_count FROM capacity_control WHERE budget_key='profiles'").first('used_count')).toBe(1);
    const context = await request('/context?preland_id=demo', auth); expect(context.headers.get('cache-control')).toBe('no-store');
    expect(await context.json()).toMatchObject({ identity_status: 'ready', user_id: auth.user });
    expect((await request('/identity/restart', { ...auth, payload: {} })).status).toBe(409);
  });
  it('new commit renews cookie, replay (including parallel winner) never creates extra effects', async () => {
    const auth = await bootstrap(); const payload = { operation_id: id(100).toUpperCase(), event_id: id(101).toUpperCase(), preland_id: 'demo' };
    const first = await request('/entries', { ...auth, payload }); expect(first.status).toBe(200);
    expect(first.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax');
    const repeated = await request('/entries', { ...auth, payload }); expect(repeated.headers.has('set-cookie')).toBe(false); expect(await repeated.json()).toEqual(await first.json());
    const found = await request('/operations/' + payload.operation_id, { ...auth, env: { ...bindings, COMMAND_HMAC_SECRET: undefined } }); expect(found.status).toBe(200); expect(found.headers.has('set-cookie')).toBe(false);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(1);
  });
  it('rejects origin, compressed/wrong/oversized/bad UTF8 JSON and extra properties without writing', async () => {
    const cases: [Record<string,string>, string, number, string][] = [
      [{ Origin: 'https://foreign.test' }, '{}', 403, 'request_origin_rejected'],
      [{ Origin: '' }, '{}', 403, 'request_origin_rejected'],
      [{ Origin: 'null' }, '{}', 403, 'request_origin_rejected'],
      [{ 'Content-Encoding': 'gzip' }, '{}', 415, 'unsupported_media_type'],
      [{ 'Content-Type': 'text/plain' }, '{}', 415, 'unsupported_media_type'],
      [{}, '{', 400, 'validation_failed'], [{}, '{"unexpected":true}', 400, 'validation_failed'],
      [{}, JSON.stringify({ x: 'x'.repeat(8192) }), 413, 'payload_too_large'],
    ];
    for (const [headers, raw, status, code] of cases) { const r = await request('/identity', { headers, raw }); expect(r.status).toBe(status); expect(await r.json()).toMatchObject({ error: { code } }); }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(0);
  });
  it('requires syntactically valid expected ID; foreign ID cannot read or mutate and cannot erase cookie', async () => {
    const auth = await bootstrap(); const payload = { operation_id: id(100), event_id: id(101), preland_id: 'demo' };
    expect(await (await request('/entries', { cookie: auth.cookie, payload })).json()).toMatchObject({ error: { code: 'validation_failed' } });
    const wrong = await request('/entries', { ...auth, user: id(999), payload }); expect(wrong.status).toBe(401); expect(wrong.headers.has('set-cookie')).toBe(false);
    expect((await request('/operations/' + id(100), { ...auth, user: id(999) })).status).toBe(401);
    expect((await request('/entries', { ...auth, payload: { ...payload, type: 'entry' } })).status).toBe(400);
    expect((await request('/entries', { ...auth, payload: { ...payload, unknown: true } })).status).toBe(400);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first('n')).toBe(0);
  });
  it('D1 failure is unavailable, invalid cookie is not missing, revoked identity cannot run', async () => {
    const auth = await bootstrap(); await db.prepare('UPDATE users SET revoked_at = ?').bind(Date.now()).run();
    expect(await (await request('/context?preland_id=demo', auth)).json()).toMatchObject({ identity_status: 'invalid' });
    expect((await request('/identity', { ...auth, payload: {} })).status).toBe(401);
    const failing = new Proxy(db, { get(target, prop, receiver) { if (prop === 'prepare') return () => { throw new Error('private failure'); }; return Reflect.get(target, prop, receiver); } });
    const r = await request('/context?preland_id=demo', { ...auth, env: { ...bindings, DB: failing } }); expect(r.status).toBe(503); expect(await r.text()).not.toContain('private failure');
  });
  it('capacity refusal issues no cookie or profile', async () => {
    await db.prepare("UPDATE capacity_control SET used_count=1000, capacity_paused=1 WHERE budget_key='profiles'").run();
    const r = await request('/identity', { payload: {} }); expect(r.status).toBe(503); expect(r.headers.has('set-cookie')).toBe(false); expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(0);
  });
  it('rate limiting is fail closed, before auth; cloud hostname cannot use local synthetic address', async () => {
    const deny = { limit: async () => ({ success: false }) } as RateLimit;
    const r = await request('/identity', { payload: {}, env: { ...bindings, QUIZ_IP_LIMITER: deny } }); expect(r.status).toBe(429); expect(r.headers.get('retry-after')).toBe('60');
    const unavailable = await request('/identity', { payload: {}, env: { ...bindings, QUIZ_IP_LIMITER: { limit: async () => { throw new Error(); } } as RateLimit } }); expect(unavailable.status).toBe(503); expect(unavailable.headers.get('retry-after')).toBe('30');
    expect((await quiz.request('https://example.test/context?preland_id=demo', {}, bindings)).status).toBe(503);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(0);
  });
  it('limits total awaited limiter time and discards late success', async () => {
    vi.useFakeTimers();
    try { const budget = { remaining: 1000 }; const slow = { limit: () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 600)) } as RateLimit;
      const one = limit(slow, 'a', budget); await vi.advanceTimersByTimeAsync(600); await one; expect(budget.remaining).toBe(400);
      const two = limit(slow, 'a', budget); const assertion = expect(two).rejects.toMatchObject({ code: 'rate_limit_unavailable' }); await vi.advanceTimersByTimeAsync(400); await assertion;
      await vi.advanceTimersByTimeAsync(200);
    } finally { vi.useRealTimers(); }
  });
  for (const refusal of ['deny', 'throw'] as const) {
    const status = refusal === 'deny' ? 429 : 503;
    const retryAfter = refusal === 'deny' ? '60' : '30';
    const code = refusal === 'deny' ? 'rate_limited' : 'rate_limit_unavailable';
    const limiter = () => ({ limit: vi.fn(async () => {
      if (refusal === 'throw') throw new Error('private limiter failure');
      return { success: false };
    }) });
    it(`UserID limiter ${refusal} after IP allow has no business effects`, async () => {
      const auth = await bootstrap(); const before = await businessSnapshot();
      const ip = { limit: vi.fn(async () => ({ success: true })) }; const user = limiter();
      const response = await request('/entries', { ...auth,
        payload: { operation_id: id(100), event_id: id(101), preland_id: 'demo' },
        env: { ...bindings, QUIZ_IP_LIMITER: ip, QUIZ_USER_LIMITER: user },
      });
      expect(ip.limit).toHaveBeenCalledOnce(); expect(user.limit).toHaveBeenCalledWith({ key: auth.user });
      expect(response.status).toBe(status); expect(response.headers.get('retry-after')).toBe(retryAfter);
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(response.headers.has('set-cookie')).toBe(false); expect(await businessSnapshot()).toEqual(before);
    });
    it(`bootstrap limiter ${refusal} after IP allow allocates nothing; ready identity bypasses it`, async () => {
      const auth = await bootstrap(); const before = await businessSnapshot();
      const ip = { limit: vi.fn(async () => ({ success: true })) }; const issuance = limiter();
      const limitedEnv = { ...bindings, QUIZ_IP_LIMITER: ip, BOOTSTRAP_LIMITER: issuance };
      const response = await request('/identity', { payload: {}, env: limitedEnv });
      expect(ip.limit).toHaveBeenCalledOnce(); expect(issuance.limit).toHaveBeenCalledOnce();
      expect(response.status).toBe(status); expect(response.headers.get('retry-after')).toBe(retryAfter);
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(response.headers.has('set-cookie')).toBe(false); expect(await businessSnapshot()).toEqual(before);
      const ready = await request('/identity', { ...auth, payload: {}, env: limitedEnv });
      expect(ready.status).toBe(200); expect(await ready.json()).toEqual({ user_id: auth.user });
      expect(ip.limit).toHaveBeenCalledTimes(2); expect(issuance.limit).toHaveBeenCalledOnce();
      expect(ready.headers.has('set-cookie')).toBe(false); expect(await businessSnapshot()).toEqual(before);
    });
  }
  it('executes full A/B through HTTP and reads the exact owned B', async () => {
    const auth = await bootstrap();
    const post = async (route: string, data: object) => { const r = await request(route, { ...auth, payload: { preland_id: 'demo', ...data } }); expect(r.status).toBe(200); return r.json(); };
    await post('/entries', { operation_id: id(10), event_id: id(11) });
    for (const [n, question_id, value] of [[20,'preferred_gender','women'],[30,'preferred_ethnicity','asia']] as const) {
      await post('/question-views', { operation_id:id(n), event_id:id(n+1), entry_event_id:id(11), question_id });
      await post('/answers', { operation_id:id(n+2), view_event_id:id(n+1), question_id, value });
    }
    await post('/question-views', {operation_id:id(40),event_id:id(41),entry_event_id:id(11),question_id:'email'});
    await post('/email-confirmations', {operation_id:id(42),view_event_id:id(41),email:'Synthetic@example.test'});
    const result = await post('/offer-selections', {operation_id:id(50),entry_event_id:id(11),completion_operation_id:id(42)});
    expect(result).toMatchObject({code:'offer_selected',offer_id:'003'});
    // Exercise an HTTP adapter of this committed result; never fetch the partner.
    const stored = JSON.parse((await db.prepare('SELECT result_json FROM request_results WHERE user_id=? AND operation_id=?')
      .bind(auth.user, id(50)).first<string>('result_json'))!) as CommandResult;
    const beforeRedirect = await businessSnapshot();
    const adapter = new Hono().get('/go', (c) => quizResultResponse(c, stored, 'redirect'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('external_fetch_forbidden'));
    try {
      const redirect = await adapter.request('https://local.test/go', { redirect: 'manual' });
      expect(redirect.status).toBe(303);
      if (stored.code !== 'offer_selected') throw new Error('expected offer');
      expect(redirect.headers.get('location')).toBe(stored.target_url);
      expect(new URL(redirect.headers.get('location')!).searchParams.get('click_id')).toBe(stored.click_id);
      expect(redirect.headers.get('cache-control')).toBe('no-store');
      expect(await redirect.text()).toBe('');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
    expect(await businessSnapshot()).toEqual(beforeRedirect);
    const noOffer = await new Hono().get('/go', (c) => quizResultResponse(c, {code:'no_offer',catalog_version:'a'.repeat(64)}, 'redirect')).request('/go');
    expect(noOffer.status).toBe(200); expect(noOffer.headers.has('location')).toBe(false);
    const accepted = await new Hono().get('/go', (c) => quizResultResponse(c, {code:'accepted',event_id:id(900)}, 'redirect')).request('/go');
    expect(accepted.status).toBe(200); expect(accepted.headers.has('location')).toBe(false);

    const reread = await request('/operations/'+id(50), auth); expect(await reread.json()).toEqual(result);
    expect((await request('/operations/'+id(99), auth)).status).toBe(404);
    await db.prepare('UPDATE request_results SET created_at=? WHERE operation_id=?').bind(Date.now()-7*86400000,id(50)).run();
    expect((await request('/operations/'+id(50), auth)).status).toBe(410);
  });
});

it('SC13 two real profiles: foreign IDs cannot read results/email or mutate either owner', async () => {
  const a=await bootstrap(), b=await bootstrap();
  await db.prepare('UPDATE users SET email=?, email_confirmed_at=? WHERE user_id=?').bind('PrivateSynthetic@example.test',Date.now(),b.user).run();
  const payload={operation_id:id(700),event_id:id(701),preland_id:'demo'};
  expect((await request('/entries',{...b,payload})).status).toBe(200);
  const before=await businessSnapshot();
  for(const path of ['/operations/'+id(700)]) {
    const foreign=await request(path,{...a,user:b.user});expect(foreign.status).toBe(401);
    const own=await request(path,a);expect(own.status).toBe(404);expect(await own.text()).not.toContain(id(701));
  }
  const ownContext=await request('/context?preland_id=demo&user_id='+b.user,a);
  const dto=await ownContext.json();expect(dto).toMatchObject({user_id:a.user});expect(dto).not.toHaveProperty('email');
  for(const options of [{...a,user:b.user,payload},{...a,payload:{...payload,user_id:b.user}}]) {
    const response=await request('/entries',options);expect(response.status).toBe(options.user===b.user?401:400);
    expect(response.headers.has('set-cookie')).toBe(false);expect(await response.text()).not.toContain('PrivateSynthetic');
  }
  expect(await businessSnapshot()).toEqual(before);
});

for(const invalid of ['revoked','expired','missing','malformed','unknown','duplicate_cookie'] as const) it(`SC13 known command replay still requires current access: ${invalid}`,async()=>{
  const auth=await bootstrap();const payload={operation_id:id(710),event_id:id(711),preland_id:'demo'};
  expect((await request('/entries',{...auth,payload})).status).toBe(200);
  let cookie=auth.cookie;
  if(invalid==='revoked')await db.prepare('UPDATE users SET revoked_at=? WHERE user_id=?').bind(Date.now(),auth.user).run();
  if(invalid==='expired'){const past=Date.now()-180*86400000;await db.prepare('UPDATE users SET created_at=?,last_active_at=? WHERE user_id=?').bind(past,past,auth.user).run();}
  if(invalid==='missing')cookie='';
  if(invalid==='malformed')cookie='__Host-unicorn=invalid';
  if(invalid==='unknown')cookie='__Host-unicorn='+encodeSecret(new Uint8Array(32).fill(4));
  if(invalid==='duplicate_cookie')cookie+='; '+(await bootstrap()).cookie;
  const before=await businessSnapshot();
  const context=await (await request('/context?preland_id=demo',{...auth,cookie})).json();
  expect(context).toMatchObject({identity_status:invalid==='missing'?'missing':'invalid'});
  expect(context).not.toHaveProperty('user_id');expect(context).not.toHaveProperty('email');
  for(const response of [await request('/entries',{...auth,cookie,payload}),await request('/operations/'+id(710),{...auth,cookie})]) {
    expect(response.status).toBe(401);expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('set-cookie')).toBe(false);expect(await response.text()).not.toContain(id(711));
  }
  expect(await businessSnapshot()).toEqual(before);
});

it('SC13 authenticated quiz rejects invalid bytes and cross-origin commands before any effects',async()=>{
  const auth=await bootstrap();const before=await businessSnapshot();
  for(const path of ['/entries','/question-views','/answers','/email-confirmations','/offer-selections']) {
    const response=await request(path,{...auth,headers:{Origin:'https://foreign.test'},payload:{operation_id:id(720),preland_id:'demo'}});
    expect(response.status).toBe(403);expect(response.headers.has('set-cookie')).toBe(false);
  }
  for(const [body,status] of [[new Uint8Array([0xff,0x7b,0x7d]),400],['null',400],['[]',400],[JSON.stringify({operation_id:id(720),event_id:id(721),preland_id:'demo',padding:'я'.repeat(4100)}),413]] as [BodyInit,number][]) {
    const response=await quiz.request('https://localhost:5173/entries',{method:'POST',headers:{Origin:'http://localhost:5173',Cookie:auth.cookie,'X-Expected-User-ID':auth.user,'Content-Type':'application/json'},body},bindings);
    expect(response.status).toBe(status);expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.has('set-cookie')).toBe(false);
  }
  expect(await businessSnapshot()).toEqual(before);
});
