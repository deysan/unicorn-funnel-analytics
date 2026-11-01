import { describe, expect, it } from 'vitest';
import { demoConfig, validateDemoConfig } from '../../scripts/demo-config';
const parameters = { name: 'unicorn-demo', databaseName: 'unicorn-demo', databaseId: '12345678-1234-4234-8234-123456789abc', origin: 'https://unicorn-demo.synthetic.workers.dev', mode: 'normal' };
describe('demo config guard', () => {
  it('reproduces a separate seven-limiter config without remote local bindings or secrets', () => {
    const config = demoConfig(parameters); expect(validateDemoConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
    expect(config.ratelimits).toHaveLength(7); expect(config.d1_databases[0].remote).toBe(false); expect(config.vars.LOCAL_RUNTIME).toBe('false');
  });
  it.each(['http://unicorn-demo.synthetic.workers.dev', 'https://localhost', 'https://other.synthetic.workers.dev', parameters.origin + '/', parameters.origin + '?email=x'])('rejects invalid origin %s', (origin) => expect(() => demoConfig({ ...parameters, origin })).toThrow());
  it.each(['00000000-0000-4000-8000-000000000001', 'placeholder', ''])('rejects missing/placeholder database', (databaseId) => expect(() => demoConfig({ ...parameters, databaseId })).toThrow());
  it('rejects local flag, mode, extra secrets/routes and limiter drift before build', () => {
    for (const mutate of [
      (c: ReturnType<typeof demoConfig>) => { c.vars.LOCAL_RUNTIME = 'true'; },
      (c: ReturnType<typeof demoConfig>) => { c.vars.MOCK_RECEIVER_MODE = 'anything'; },
      (c: ReturnType<typeof demoConfig>) => { c.ratelimits[0].simple.period = 10; },
      (c: ReturnType<typeof demoConfig>) => { c.d1_databases.push(c.d1_databases[0]); },
      (c: ReturnType<typeof demoConfig>) => { Object.assign(c.vars, { IP_HMAC_SECRET: 'private' }); },
      (c: ReturnType<typeof demoConfig>) => { Object.assign(c, { routes: ['*/*'] }); },
    ]) { const c = demoConfig(parameters); mutate(c); expect(() => validateDemoConfig(c)).toThrow(); }
  });
});
