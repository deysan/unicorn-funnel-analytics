import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { ipKey, encodeSecret, type QuizBindings } from '../../src/server/http/security';
import { quiz } from '../../src/server/http/quiz';
import { db, freshBusinessDb } from './helpers/business-db';
const secret = encodeSecret(new Uint8Array(32).fill(7));
const cloud = { LOCAL_RUNTIME: 'false', IP_HMAC_SECRET: secret };
function request(address?: string, extra: Record<string,string> = {}, trusted = true) {
  const req = new Request('https://unicorn-demo.synthetic.workers.dev/identity', { method: 'POST', headers: {
    'Content-Type':'application/json', Origin:'https://unicorn-demo.synthetic.workers.dev', ...(address ? {'CF-Connecting-IP':address} : {}), ...extra }, body:'{}' });
  if (trusted) Object.defineProperty(req, 'cf', {value:{colo:'FRA'}}); return req;
}
beforeEach(freshBusinessDb);
it.each([
  ['2001:0db8:0000:0000:0000:0000:0000:0001','2001:db8::1'],
  ['::FFFF:192.0.2.1','192.0.2.1'], ['2001:DB8::A','2001:db8::a'],
])('canonicalizes equivalent IPv4/IPv6 HMAC keys', async (a,b) => {
  const key = await ipKey(request(a),cloud); expect(key).toMatch(/^[a-f0-9]{64}$/); expect(key).toBe(await ipKey(request(b),cloud));
});
it.each([
  ['192.0.2.1', '192.0.2.2'],
  ['2001:db8::1', '2001:db8::2'],
])('keeps distinct client addresses in separate HMAC budgets', async (a, b) => {
  expect(await ipKey(request(a), cloud)).not.toBe(await ipKey(request(b), cloud));
});
it('ignores arbitrary x-real-ip on a direct edge request without changing the trusted CF-IP key', async () => {
  const expected = await ipKey(request('192.0.2.1'), cloud);
  for (const value of ['203.0.113.2', '2001:db8::2', 'not-an-address']) {
    expect(await ipKey(request('192.0.2.1', { 'X-Real-IP': value }), cloud)).toBe(expected);
  }
  await expect(ipKey(request(undefined, { 'X-Real-IP': '192.0.2.1' }), cloud)).rejects.toMatchObject({ code: 'rate_limit_unavailable' });
});
it('cloud Hono accepts direct edge x-real-ip but still rejects same-zone Worker subrequests before writes', async () => {
  const allow = { limit: async () => ({ success: true }) } as RateLimit;
  const bindings: QuizBindings = { ...env, ...cloud, ALLOWED_ORIGINS: 'https://unicorn-demo.synthetic.workers.dev',
    COMMAND_HMAC_SECRET: secret, QUIZ_IP_LIMITER: allow, QUIZ_USER_LIMITER: allow, BOOTSTRAP_LIMITER: allow };
  const direct = await quiz.fetch(request('192.0.2.1', { 'X-Real-IP': 'arbitrary' }), bindings);
  expect(direct.status).toBe(201);
  const before = (await db.prepare('SELECT * FROM capacity_control').all()).results;
  const subrequest = await quiz.fetch(request('192.0.2.1', { 'X-Real-IP': 'arbitrary', 'CF-Worker': 'synthetic.workers.dev' }), bindings);
  expect(subrequest.status).toBe(503); expect(subrequest.headers.get('Retry-After')).toBe('30');
  expect(await subrequest.json()).toMatchObject({ error: { code: 'rate_limit_unavailable' } });
  expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(1);
  expect((await db.prepare('SELECT * FROM capacity_control').all()).results).toEqual(before);
});
it('ignores user forwarded headers; local runtime stays synthetic', async () => {
  expect(await ipKey(request('192.0.2.1',{'X-Forwarded-For':'203.0.113.2'}),cloud)).toBe(await ipKey(request('192.0.2.1'),cloud));
  const local={...cloud,LOCAL_RUNTIME:'true'};
  expect(await ipKey(new Request('http://localhost/',{headers:{'CF-Connecting-IP':'bad','CF-Worker':'spoof'}}),local)).toBe(await ipKey(new Request('http://localhost/'),local));
});
it.each([undefined,'bad','192.0.2.1, 192.0.2.2','192.000.2.1','[::1]','fe80::1%eth0','2a06:98c0:3600::103'])('fails closed without any business mutation for missing/invalid/proxy IP',async(address)=>{
  const allow={limit:async()=>({success:true})} as RateLimit;
  const bindings: QuizBindings={...env,...cloud,ALLOWED_ORIGINS:'https://unicorn-demo.synthetic.workers.dev',COMMAND_HMAC_SECRET:secret,QUIZ_IP_LIMITER:allow,QUIZ_USER_LIMITER:allow,BOOTSTRAP_LIMITER:allow};
  const before=(await db.prepare('SELECT * FROM capacity_control').all()).results;
  const response=await quiz.fetch(request(address),bindings);
  expect(response.status).toBe(503);expect(response.headers.get('Retry-After')).toBe('30');expect(await response.json()).toMatchObject({error:{code:'rate_limit_unavailable'}});
  expect(await db.prepare('SELECT COUNT(*) AS n FROM users').first('n')).toBe(0);expect((await db.prepare('SELECT * FROM capacity_control').all()).results).toEqual(before);
});
it('rejects untrusted edge context, subrequests and pseudo IPv4',async()=>{
  for(const req of [request('192.0.2.1',{},false),...['CF-Worker','CF-Connecting-IPv6','CF-Pseudo-IPv4'].map(name=>request('192.0.2.1',{[name]:'present'}))]) await expect(ipKey(req,cloud)).rejects.toMatchObject({code:'rate_limit_unavailable',retryAfter:30});
});
